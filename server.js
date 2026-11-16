/*
 * HOLO BACKEND
 * Node.js + Express + Supabase + Groq + Pokémon TCG API + PayPal
 */

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const {
  GROQ_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  POKEMONTCG_API_KEY,
  FRONTEND_ORIGIN,
  PAYPAL_CLIENT_ID = 'BAA8bGxWP8Qy_Un_xkAGO7LDioFhOoTSq6yH36DUff3ELNK8-M_Y-KFk7SWBsWZean7p4K4NbZgcSzMRrc',
  PAYPAL_SECRET,
  PAYPAL_MODE = 'live',
  FREE_ACCESS_EMAILS = '',
  GROQ_MODEL = 'qwen/qwen3.8-27b',
  PORT = 3000,
} = process.env;

const BADGE_THRESHOLD = 1000;
const PLAN_BASE = 'P-5D518934NU797154NNLSNGNQ';
const PLAN_VERIFIED = 'P-0JC88557EV905654NNLSNH4Y';

const FREE_SET = new Set(
  FREE_ACCESS_EMAILS.split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
);

if (!GROQ_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing GROQ_API_KEY, SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const db = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const app = express();

app.use(cors(
  FRONTEND_ORIGIN ? { origin: FRONTEND_ORIGIN } : {}
));

app.use(express.json({ limit: '8mb' }));

/* ---------- helpers ---------- */

const wrap = fn => (req, res, next) =>
  fn(req, res, next).catch(e => {
    console.error(e);
    res.status(e.status || 500).json({
      error: e.status ? e.message : 'Something went wrong'
    });
  });

const fail = (status, message) =>
  Object.assign(new Error(message), { status });

const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;

/* ---------- rate limiter ---------- */

const hits = new Map();

function limit(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip;
    const now = Date.now();

    const arr = (hits.get(k) || [])
      .filter(t => now - t < windowMs);

    if (arr.length >= max) {
      return res.status(429).json({
        error: 'Slow down, too many scans. Try again in a minute.'
      });
    }

    arr.push(now);
    hits.set(k, arr);
    next();
  };
}

setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

/* ---------- authentication ---------- */

async function getUser(req) {
  if (req._u) return req._u;

  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;

  if (!token) return null;

  const { data, error } = await db.auth.getUser(token);

  if (error || !data?.user) return null;

  await ensureProfile(data.user);

  req._u = data.user;
  return data.user;
}

const optionalAuth = wrap(async (req, _res, next) => {
  req.user = await getUser(req);
  next();
});

const requireAuth = wrap(async (req, _res, next) => {
  req.user = await getUser(req);

  if (!req.user) {
    throw fail(401, 'Please sign in.');
  }

  next();
});

/* ---------- profiles ---------- */

async function ensureProfile(user) {
  const free = FREE_SET.has(
    (user.email || '').toLowerCase()
  );

  const { data } = await db
    .from('profiles')
    .select('id,free_access')
    .eq('id', user.id)
    .maybeSingle();

  if (data) {
    if (free && !data.free_access) {
      await db
        .from('profiles')
        .update({
          free_access: true,
          verified: true
        })
        .eq('id', user.id);
    }

    return;
  }

  let base = (
    user.user_metadata?.username ||
    (user.email || 'collector').split('@')[0]
  )
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 16) || 'collector';

  if (base.length < 3) base += 'user';

  for (let i = 0; i < 5; i++) {
    const username = i === 0
      ? base
      : base + Math.floor(Math.random() * 9999);

    const { error } = await db
      .from('profiles')
      .insert({
        id: user.id,
        username,
        free_access: free,
        verified: free
      });

    if (!error) return;
  }
}

/* ---------- PayPal subscriptions ---------- */

const PP = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

async function ppSub(id) {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    throw fail(500, 'Payments are not configured.');
  }

  const t = await fetch(PP + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization:
        'Basic ' +
        Buffer.from(
          PAYPAL_CLIENT_ID + ':' + PAYPAL_SECRET
        ).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!t.ok) {
    throw fail(502, 'Could not reach PayPal.');
  }

  const { access_token } = await t.json();

  const r = await fetch(
    PP + '/v1/billing/subscriptions/' + encodeURIComponent(id),
    {
      headers: {
        Authorization: 'Bearer ' + access_token
      }
    }
  );

  if (!r.ok) {
    throw fail(404, 'Subscription not found.');
  }

  return r.json();
}

async function saveSub(userId, freeAccess, sub) {
  const active = sub.status === 'ACTIVE';

  const plan =
    sub.plan_id === PLAN_VERIFIED
      ? 'verified'
      : sub.plan_id === PLAN_BASE
        ? 'base'
        : null;

  await db
    .from('profiles')
    .update({
      subscription_id: sub.id,
      plan,
      sub_status: sub.status,
      sub_checked_at: new Date().toISOString(),
      verified: !!freeAccess ||
        (active && plan === 'verified')
    })
    .eq('id', userId);
}

async function accessFor(userId, p) {
  if (p?.free_access) return true;
  if (!p?.subscription_id) return false;

  const stale =
    !p.sub_checked_at ||
    Date.now() - new Date(p.sub_checked_at).getTime()
      > 6 * 3600 * 1000;

  if (stale) {
    try {
      const sub = await ppSub(p.subscription_id);
      await saveSub(userId, false, sub);
      return sub.status === 'ACTIVE';
    } catch (e) {
      // PayPal unreachable: retain last known status.
    }
  }

  return p.sub_status === 'ACTIVE';
}

const paid = wrap(async (req, _res, next) => {
  const u = await getUser(req);

  if (!u) throw fail(401, 'Please sign in.');

  req.user = u;

  const { data: p } = await db
    .from('profiles')
    .select('free_access,subscription_id,sub_status,sub_checked_at')
    .eq('id', u.id)
    .single();

  if (!(await accessFor(u.id, p))) {
    throw fail(402, 'subscription_required');
  }

  next();
});

/* ---------- collection statistics ---------- */

async function recalc(userId) {
  const { data } = await db
    .from('cards')
    .select('price')
    .eq('user_id', userId);

  const total = (data || []).reduce(
    (a, c) => a + Number(c.price || 0),
    0
  );

  const { data: p } = await db
    .from('profiles')
    .select('badge')
    .eq('id', userId)
    .single();

  const badge =
    !!p?.badge || total >= BADGE_THRESHOLD;

  const total_value = Math.round(total * 100) / 100;

  await db
    .from('profiles')
    .update({
      total_value,
      card_count: data?.length || 0,
      badge
    })
    .eq('id', userId);

  return {
    total_value,
    card_count: data?.length || 0,
    badge
  };
}

async function counts(userId) {
  const [a, b] = await Promise.all([
    db.from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('following_id', userId),

    db.from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('follower_id', userId)
  ]);

  return {
    followers: a.count || 0,
    following: b.count || 0
  };
}

async function followedSet(meId, ids) {
  if (!meId || !ids.length) return new Set();

  const { data } = await db
    .from('follows')
    .select('following_id')
    .eq('follower_id', meId)
    .in('following_id', ids);

  return new Set(
    (data || []).map(r => r.following_id)
  );
}

async function decorate(rows, meId) {
  const set = await followedSet(
    meId,
    rows.map(r => r.id)
  );

  return rows.map(r => ({
    ...r,
    is_following: set.has(r.id),
    is_me: r.id === meId
  }));
}