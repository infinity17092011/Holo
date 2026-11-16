/*
 * CardScan / Holo server
 * Node 18+
 *
 * Required Render environment variables:
 * GROQ_API_KEY
 * SUPABASE_URL
 * SUPABASE_SERVICE_KEY
 * PAYPAL_SECRET
 *
 * Optional:
 * POKEMONTCG_API_KEY
 * FRONTEND_ORIGIN
 * PAYPAL_MODE
 * FREE_ACCESS_EMAILS
 * GROQ_MODEL
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
  FREE_ACCESS_EMAILS
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
);

if (!GROQ_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    'Missing GROQ_API_KEY, SUPABASE_URL or SUPABASE_SERVICE_KEY'
  );
  process.exit(1);
}

const db = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  {
    auth: {
      persistSession: false
    }
  }
);

const app = express();

app.use(
  cors(
    FRONTEND_ORIGIN
      ? { origin: FRONTEND_ORIGIN }
      : {}
  )
);

app.use(express.json({ limit: '8mb' }));

/* ---------- helpers ---------- */

const wrap = fn => (req, res, next) =>
  fn(req, res, next).catch(e => {
    console.error(e);

    res.status(e.status || 500).json({
      error: e.status
        ? e.message
        : 'Something went wrong'
    });
  });

const fail = (status, message) =>
  Object.assign(new Error(message), { status });

const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;

/* ---------- scan rate limiter ---------- */

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

setInterval(() => {
  hits.clear();
}, 10 * 60 * 1000).unref();

/* ---------- authentication ---------- */

async function getUser(req) {
  if (req._u) return req._u;

  const h = req.headers.authorization || '';

  const token = h.startsWith('Bearer ')
    ? h.slice(7)
    : null;

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

/* ---------- profile creation ---------- */

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

  if (base.length < 3) {
    base += 'user';
  }

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

  const t = await fetch(
    PP + '/v1/oauth2/token',
    {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(
            PAYPAL_CLIENT_ID + ':' + PAYPAL_SECRET
          ).toString('base64'),

        'Content-Type':
          'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    }
  );

  if (!t.ok) {
    throw fail(502, 'Could not reach PayPal.');
  }

  const { access_token } = await t.json();

  const r = await fetch(
    PP + '/v1/billing/subscriptions/' +
    encodeURIComponent(id),
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

      verified:
        !!freeAccess ||
        (active && plan === 'verified')
    })
    .eq('id', userId);
}

async function accessFor(userId, p) {
  if (p?.free_access) return true;

  if (!p?.subscription_id) return false;

  const stale =
    !p.sub_checked_at ||
    Date.now() -
      new Date(p.sub_checked_at).getTime() >
      6 * 3600 * 1000;

  if (stale) {
    try {
      const sub = await ppSub(p.subscription_id);

      await saveSub(userId, false, sub);

      return sub.status === 'ACTIVE';
    } catch (e) {
      // Keep the last known subscription status
    }
  }

  return p.sub_status === 'ACTIVE';
}

/* ---------- paid access middleware ---------- */

const paid = wrap(async (req, _res, next) => {
  const u = await getUser(req);

  if (!u) {
    throw fail(401, 'Please sign in.');
  }

  req.user = u;

  const { data: p } = await db
    .from('profiles')
    .select(
      'free_access,subscription_id,sub_status,sub_checked_at'
    )
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
    !!p?.badge ||
    total >= BADGE_THRESHOLD;

  const total_value =
    Math.round(total * 100) / 100;

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
/* ---------- follower counts ---------- */

async function counts(userId) {
  const [a, b] = await Promise.all([
    db
      .from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('following_id', userId),

    db
      .from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('follower_id', userId)
  ]);

  return {
    followers: a.count || 0,
    following: b.count || 0
  };
}

async function followedSet(meId, ids) {
  if (!meId || !ids.length) {
    return new Set();
  }

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

/* ---------- Pokémon card price data ---------- */

const TCG = 'https://api.pokemontcg.io/v2';

const tcgHeaders = POKEMONTCG_API_KEY
  ? { 'X-Api-Key': POKEMONTCG_API_KEY }
  : {};

function priceOf(c) {
  const p = c?.tcgplayer?.prices;

  if (!p) return null;

  const k = Object.values(p)[0];

  const v = k?.market ?? k?.mid ?? null;

  return v == null
    ? null
    : Math.round(Number(v) * 100) / 100;
}

const shape = c => ({
  id: c.id,
  name: c.name,
  set: c.set?.name,
  number: c.number,
  rarity: c.rarity || null,
  image: c.images?.small,
  image_large: c.images?.large,
  price: priceOf(c)
});

async function tcgSearch(q, pageSize = 8) {
  const r = await fetch(
    `${TCG}/cards?pageSize=${pageSize}&q=${encodeURIComponent(q)}`,
    {
      headers: tcgHeaders,
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!r.ok) {
    const details = await r.text().catch(() => '');

    console.error(
      'Pokemon TCG API error:',
      r.status,
      details.slice(0, 1000)
    );

    throw fail(
      502,
      'Price service is unavailable right now.'
    );
  }

  const json = await r.json();

  return (json.data || []).map(shape);
}

async function findCards(name, number) {
  const clean = String(name || '')
    .replace(/["\\]/g, '')
    .trim();

  const num = String(number || '')
    .split('/')[0]
    .replace(/^0+/, '')
    .replace(/[^A-Za-z0-9]/g, '');

  if (!clean) return [];

  if (num) {
    const exact = await tcgSearch(
      `name:"${clean}" number:${num}`
    );

    if (exact.length) return exact;
  }

  return tcgSearch(`name:"${clean}"`);
}

async function tcgById(id) {
  const r = await fetch(
    `${TCG}/cards/${encodeURIComponent(id)}`,
    {
      headers: tcgHeaders,
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!r.ok) return null;

  const json = await r.json();

  return shape(json.data);
}

/* ---------- Groq vision card identification ---------- */

async function groqIdentify(image) {
  if (!GROQ_API_KEY) {
    throw fail(
      500,
      'AI scanner is not configured.'
    );
  }

  let response;

  try {
    response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`
        },

        body: JSON.stringify({
          model: GROQ_MODEL,
          temperature: 0.1,
          max_completion_tokens: 500,

          response_format: {
            type: 'json_object'
          },

          messages: [
            {
              role: 'user',

              content: [
                {
                  type: 'text',

                  text: [
                    'You identify Pokémon trading cards from photos.',
                    'Inspect the image and decide whether it clearly shows a genuine Pokémon trading card.',
                    'Return exactly one valid JSON object with these fields:',
                    '{"is_card":true,"name":"Pokemon name","number":"collector number only, without the set total","set":"set name","rarity":"rarity if readable","about":"two short useful sentences for a collector"}',
                    'If it is not clearly a Pokémon trading card, return:',
                    '{"is_card":false,"name":"","number":"","set":"","rarity":"","about":""}',
                    'Do not guess unreadable card details.',
                    'Use an empty string when a detail cannot be read.',
                    'Do not provide prices.',
                    'Do not include markdown or text outside the JSON object.'
                  ].join(' ')
                },

                {
                  type: 'image_url',
                  image_url: {
                    url: image
                  }
                }
              ]
            }
          ]
        }),

        signal: AbortSignal.timeout(45000)
      }
    );

  } catch (error) {
    console.error(
      'Groq request failed:',
      error.message
    );

    throw fail(
      502,
      'The AI scanner could not connect. Please try again.'
    );
  }

  if (!response.ok) {
    const details = await response
      .text()
      .catch(() => '');

    console.error(
      'Groq API error:',
      response.status,
      details.slice(0, 1200)
    );

    throw fail(
      502,
      'The AI scanner is unavailable right now.'
    );
  }

  let payload;

  try {
    payload = await response.json();

  } catch (error) {
    console.error(
      'Groq returned invalid JSON:',
      error.message
    );

    throw fail(
      502,
      'The AI scanner returned an invalid response.'
    );
  }

  const content =
    payload.choices?.[0]?.message?.content || '';

  let result;

  try {
    result = JSON.parse(content);

  } catch (error) {
    const match = content.match(/\{[\s\S]*\}/);

    if (!match) {
      console.error(
        'Groq response did not contain JSON:',
        content.slice(0, 1000)
      );

      throw fail(
        422,
        'Could not read that card. Try a clearer photo.'
      );
    }

    try {
      result = JSON.parse(match[0]);

    } catch (parseError) {
      console.error(
        'Could not parse Groq card response:',
        parseError.message
      );

      throw fail(
        422,
        'Could not read that card. Try a clearer photo.'
      );
    }
  }

  return {
    is_card: result.is_card === true,

    name:
      typeof result.name === 'string'
        ? result.name.trim()
        : '',

    number:
      typeof result.number === 'string'
        ? result.number.trim()
        : '',

    set:
      typeof result.set === 'string'
        ? result.set.trim()
        : '',

    rarity:
      typeof result.rarity === 'string'
        ? result.rarity.trim()
        : '',

    about:
      typeof result.about === 'string'
        ? result.about.trim()
        : ''
  };
}

/* ---------- basic routes ---------- */

app.get('/', (_req, res) => {
  res.json({ ok: true });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    badge_threshold: BADGE_THRESHOLD
  });
});

/* ---------- authentication ---------- */

async function sessionFor(email, password) {
  const c = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );

  const { data, error } =
    await c.auth.signInWithPassword({
      email,
      password
    });

  if (error || !data?.session) {
    throw fail(
      401,
      'Wrong email or password.'
    );
  }

  return {
    token: data.session.access_token,
    refresh_token: data.session.refresh_token
  };
}

app.post(
  '/auth/signup',
  wrap(async (req, res) => {
    const email = String(
      req.body?.email || ''
    ).trim().toLowerCase();

    const password = String(
      req.body?.password || ''
    );

    const username = String(
      req.body?.username || ''
    ).trim();

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      throw fail(400, 'Enter a valid email.');
    }

    if (password.length < 6) {
      throw fail(
        400,
        'Password must be at least 6 characters.'
      );
    }

    if (!USERNAME_RE.test(username)) {
      throw fail(
        400,
        'Username must be 3-20 letters, numbers or underscores.'
      );
    }

    const { data: taken } = await db
      .from('profiles')
      .select('id')
      .ilike('username', username)
      .maybeSingle();

    if (taken) {
      throw fail(409, 'That username is taken.');
    }

    const { error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,

      user_metadata: {
        username: username.toLowerCase()
      }
    });

    if (error) {
      throw fail(
        400,
        /registered|exists/i.test(error.message)
          ? 'That email already has an account.'
          : 'Could not create account.'
      );
    }

    res.json(
      await sessionFor(email, password)
    );
  })
);

app.post(
  '/auth/login',
  wrap(async (req, res) => {
    res.json(
      await sessionFor(
        String(req.body?.email || '')
          .trim()
          .toLowerCase(),

        String(req.body?.password || '')
      )
    );
  })
);

app.post(
  '/auth/refresh',
  wrap(async (req, res) => {
    const c = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    const { data, error } =
      await c.auth.refreshSession({
        refresh_token: String(
          req.body?.refresh_token || ''
        )
      });

    if (error || !data?.session) {
      throw fail(401, 'Session expired.');
    }

    res.json({
      token: data.session.access_token,
      refresh_token: data.session.refresh_token
    });
  })
);

/* ---------- subscription activation ---------- */

app.post(
  '/subscription/activate',
  requireAuth,
  wrap(async (req, res) => {
    const id = String(
      req.body?.subscriptionID || ''
    ).trim();

    if (!id) {
      throw fail(400, 'Missing subscription.');
    }

    const sub = await ppSub(id);

    if (
      sub.plan_id !== PLAN_BASE &&
      sub.plan_id !== PLAN_VERIFIED
    ) {
      throw fail(400, 'Unknown plan.');
    }

    if (sub.status !== 'ACTIVE') {
      throw fail(
        402,
        'PayPal has not activated this subscription yet.'
      );
    }

    const { data: other } = await db
      .from('profiles')
      .select('id')
      .eq('subscription_id', id)
      .neq('id', req.user.id)
      .maybeSingle();

    if (other) {
      throw fail(
        409,
        'This subscription is already linked to another account.'
      );
    }

    const { data: p } = await db
      .from('profiles')
      .select('free_access')
      .eq('id', req.user.id)
      .single();

    await saveSub(
      req.user.id,
      p?.free_access,
      sub
    );

    res.json({
      ok: true,

      plan:
        sub.plan_id === PLAN_VERIFIED
          ? 'verified'
          : 'base'
    });
  })
);

/* ---------- paid routes ---------- */

app.use(
  [
    '/scan',
    '/search',
    '/collection',
    '/leaderboard',
    '/profile',
    '/discover',
    '/follow',
    '/me/avatar'
  ],
  paid
);
/* ---------- card scanning ---------- */

// Groq identifies the card.
// Pokémon TCG supplies matching cards and market prices.

app.post(
  '/scan',
  limit(10, 60 * 1000),
  wrap(async (req, res) => {
    const image = req.body?.image;

    if (
      typeof image !== 'string' ||
      !/^data:image\/(jpeg|png|webp);base64,/.test(image)
    ) {
      throw fail(
        400,
        'Send a photo as a base64 image.'
      );
    }

    const id = await groqIdentify(image);

    if (!id.is_card || !id.name) {
      throw fail(
        422,
        'That does not look like a Pokemon card.'
      );
    }

    const matches = await findCards(
      id.name,
      id.number
    );

    res.json({
      name: id.name,
      number: id.number || '',
      set: id.set || '',
      rarity: id.rarity || '',
      about: id.about || '',
      matches
    });
  })
);

/* ---------- card search ---------- */

app.get(
  '/search',
  wrap(async (req, res) => {
    const q = String(
      req.query.q || ''
    ).trim();

    if (!q) {
      return res.json({ cards: [] });
    }

    res.json({
      cards: await findCards(q, '')
    });
  })
);

/* ---------- collection ---------- */

app.get(
  '/collection',
  requireAuth,
  wrap(async (req, res) => {
    const { data, error } = await db
      .from('cards')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', {
        ascending: false
      });

    if (error) throw error;

    const { data: p } = await db
      .from('profiles')
      .select(
        'total_value,card_count,badge,verified'
      )
      .eq('id', req.user.id)
      .single();

    res.json({
      cards: data,
      total_value: p?.total_value || 0,
      card_count: p?.card_count || 0,
      badge: !!p?.badge,
      badge_threshold: BADGE_THRESHOLD
    });
  })
);

app.post(
  '/collection',
  requireAuth,
  wrap(async (req, res) => {
    const cardId = req.body?.card_id;

    if (!cardId) {
      throw fail(400, 'card_id is required.');
    }

    // Get card details and price from the server.
    const card = await tcgById(cardId);

    if (!card) {
      throw fail(404, 'Card not found.');
    }

    const { error } = await db
      .from('cards')
      .insert({
        user_id: req.user.id,
        card_id: card.id,
        name: card.name,
        set_name: card.set,
        number: card.number,
        image: card.image,
        price: card.price || 0
      });

    if (error) throw error;

    const stats = await recalc(req.user.id);

    res.json({
      ok: true,
      ...stats,
      badge_threshold: BADGE_THRESHOLD
    });
  })
);

app.delete(
  '/collection/:id',
  requireAuth,
  wrap(async (req, res) => {
    await db
      .from('cards')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    res.json({
      ok: true,
      ...(await recalc(req.user.id))
    });
  })
);

/* ---------- refresh collection prices ---------- */

app.post(
  '/collection/refresh',
  requireAuth,
  wrap(async (req, res) => {
    const { data } = await db
      .from('cards')
      .select('id,card_id')
      .eq('user_id', req.user.id)
      .limit(300);

    const unique = [
      ...new Set(
        (data || []).map(c => c.card_id)
      )
    ];

    const fresh = {};

    for (let i = 0; i < unique.length; i += 5) {
      await Promise.all(
        unique.slice(i, i + 5).map(async id => {
          const c = await tcgById(id);

          if (c?.price != null) {
            fresh[id] = c.price;
          }
        })
      );
    }

    for (const c of data || []) {
      if (fresh[c.card_id] != null) {
        await db
          .from('cards')
          .update({
            price: fresh[c.card_id]
          })
          .eq('id', c.id);
      }
    }

    res.json({
      ok: true,
      ...(await recalc(req.user.id))
    });
  })
);

/* ---------- leaderboard ---------- */

app.get(
  '/leaderboard',
  optionalAuth,
  wrap(async (req, res) => {
    const lim = Math.min(
      Number(req.query.limit) || 50,
      100
    );

    const { data, error } = await db
      .from('profiles')
      .select(
        'id,username,avatar_url,total_value,card_count,badge,verified'
      )
      .gt('card_count', 0)
      .order('total_value', {
        ascending: false
      })
      .limit(lim);

    if (error) throw error;

    const rows = (
      await decorate(data, req.user?.id)
    ).map((r, i) => ({
      ...r,
      rank: i + 1
    }));

    res.json({
      leaderboard: rows
    });
  })
);

/* ---------- current user ---------- */

app.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const { data: p, error } = await db
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;

    const subscribed = await accessFor(
      req.user.id,
      p
    );

    const { data: fresh } = await db
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    const {
      subscription_id,
      ...safe
    } = fresh || p;

    res.json({
      ...safe,
      subscribed,
      email: req.user.email,
      ...(await counts(req.user.id)),
      badge_threshold: BADGE_THRESHOLD
    });
  })
);

/* ---------- update profile ---------- */

app.patch(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const patch = {};

    if (req.body.username != null) {
      const u = String(
        req.body.username
      ).trim();

      if (!USERNAME_RE.test(u)) {
        throw fail(
          400,
          'Username must be 3-20 letters, numbers or underscores.'
        );
      }

      patch.username = u.toLowerCase();
    }

    if (req.body.bio != null) {
      patch.bio = String(
        req.body.bio
      ).slice(0, 160);
    }

    if (!Object.keys(patch).length) {
      throw fail(400, 'Nothing to update.');
    }

    const { data, error } = await db
      .from('profiles')
      .update(patch)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) {
      throw fail(
        error.code === '23505' ? 409 : 400,
        error.code === '23505'
          ? 'That username is taken.'
          : 'Could not update profile.'
      );
    }

    res.json(data);
  })
);

/* ---------- profile avatar ---------- */

app.post(
  '/me/avatar',
  requireAuth,
  wrap(async (req, res) => {
    const m = String(
      req.body?.image || ''
    ).match(
      /^data:(image\/(jpeg|png|webp));base64,(.+)$/
    );

    if (!m) {
      throw fail(
        400,
        'Send a jpeg, png or webp image.'
      );
    }

    const buf = Buffer.from(m[3], 'base64');

    if (buf.length > 2 * 1024 * 1024) {
      throw fail(
        413,
        'Image must be under 2 MB.'
      );
    }

    const path =
      `${req.user.id}/${Date.now()}.${m[2].split('/')[1]}`;

    const up = await db
      .storage
      .from('avatars')
      .upload(path, buf, {
        contentType: m[1],
        upsert: true
      });

    if (up.error) {
      throw fail(500, 'Upload failed.');
    }

    const url = db
      .storage
      .from('avatars')
      .getPublicUrl(path)
      .data.publicUrl;

    await db
      .from('profiles')
      .update({
        avatar_url: url
      })
      .eq('id', req.user.id);

    res.json({
      avatar_url: url
    });
  })
);

/* ---------- profiles and follows ---------- */

async function profileByName(name) {
  const { data } = await db
    .from('profiles')
    .select(
      'id,username,avatar_url,bio,total_value,card_count,badge,verified,created_at'
    )
    .ilike('username', name)
    .maybeSingle();

  if (!data) {
    throw fail(404, 'Profile not found.');
  }

  return data;
}

app.get(
  '/profile/:username',
  optionalAuth,
  wrap(async (req, res) => {
    const p = await profileByName(
      req.params.username
    );

    const [c, flw] = await Promise.all([
      counts(p.id),
      followedSet(req.user?.id, [p.id])
    ]);

    const { data: top } = await db
      .from('cards')
      .select('name,set_name,image,price')
      .eq('user_id', p.id)
      .order('price', {
        ascending: false
      })
      .limit(6);

    res.json({
      ...p,
      ...c,
      is_following: flw.has(p.id),
      is_me: p.id === req.user?.id,
      top_cards: top || []
    });
  })
);

/* ---------- followers and following ---------- */

async function listFollows(req, res, mode) {
  const p = await profileByName(
    req.params.username
  );

  const mine = mode === 'followers'
    ? 'following_id'
    : 'follower_id';

  const other = mode === 'followers'
    ? 'follower_id'
    : 'following_id';

  const { data } = await db
    .from('follows')
    .select(other)
    .eq(mine, p.id)
    .order('created_at', {
      ascending: false
    })
    .limit(100);

  const ids = (data || []).map(
    r => r[other]
  );

  if (!ids.length) {
    return res.json({
      users: []
    });
  }

  const { data: users } = await db
    .from('profiles')
    .select(
      'id,username,avatar_url,total_value,badge,verified'
    )
    .in('id', ids);

  res.json({
    users: await decorate(
      users || [],
      req.user?.id
    )
  });
}

app.get(
  '/profile/:username/followers',
  optionalAuth,
  wrap((req, res) =>
    listFollows(req, res, 'followers')
  )
);

app.get(
  '/profile/:username/following',
  optionalAuth,
  wrap((req, res) =>
    listFollows(req, res, 'following')
  )
);

/* ---------- follow a user ---------- */

app.post(
  '/follow/:userId',
  requireAuth,
  wrap(async (req, res) => {
    if (req.params.userId === req.user.id) {
      throw fail(
        400,
        'You cannot follow yourself.'
      );
    }

    const { error } = await db
      .from('follows')
      .upsert({
        follower_id: req.user.id,
        following_id: req.params.userId
      });

    if (error) {
      throw fail(404, 'User not found.');
    }

    res.json({
      ok: true,
      is_following: true,
      ...(await counts(req.params.userId))
    });
  })
);

app.delete(
  '/follow/:userId',
  requireAuth,
  wrap(async (req, res) => {
    await db
      .from('follows')
      .delete()
      .eq('follower_id', req.user.id)
      .eq('following_id', req.params.userId);

    res.json({
      ok: true,
      is_following: false,
      ...(await counts(req.params.userId))
    });
  })
);

/* ---------- discover collectors ---------- */

app.get(
  '/discover',
  optionalAuth,
  wrap(async (req, res) => {
    const q = String(
      req.query.q || ''
    )
      .trim()
      .replace(/[%_,()]/g, '');

    let query = db
      .from('profiles')
      .select(
        'id,username,avatar_url,bio,total_value,card_count,badge,verified'
      )
      .limit(30);

    if (q) {
      query = query.ilike(
        'username',
        `%${q}%`
      );
    } else {
      query = query.order(
        'total_value',
        { ascending: false }
      );
    }

    if (req.user) {
      query = query.neq(
        'id',
        req.user.id
      );
    }

    const { data, error } = await query;

    if (error) throw error;

    let rows = await decorate(
      data || [],
      req.user?.id
    );

    if (!q) {
      rows = rows.filter(
        r => !r.is_following
      );
    }

    res.json({
      users: rows
    });
  })
);

/* ---------- 404 ---------- */

app.use((_req, res) => {
  res.status(404).json({
    error: 'Not found'
  });
});

/* ---------- start server ---------- */

app.listen(PORT, () => {
  console.log(
    `CardScan server listening on ${PORT}`
  );
});