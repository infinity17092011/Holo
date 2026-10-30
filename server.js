/*
 * CardScan server
 *
 * ENV VARS (set on Render):
 *   GROQ_API_KEY          required
 *   SUPABASE_URL          required
 *   SUPABASE_SERVICE_KEY  required (service_role key, keep it secret)
 *   GROQ_MODEL            optional, default meta-llama/llama-4-scout-17b-16e-instruct
 *   POKEMONTCG_API_KEY    optional, raises the price API rate limit
 *   FRONTEND_ORIGIN       optional, e.g. https://yourname.github.io (default: allow all)
 *
 * SUPABASE SETUP (run once in the SQL editor):
 *
 *   create table profiles (
 *     id uuid primary key references auth.users(id) on delete cascade,
 *     username text unique not null,
 *     avatar_url text,
 *     bio text default '',
 *     total_value numeric not null default 0,
 *     card_count int not null default 0,
 *     badge boolean not null default false,
 *     created_at timestamptz default now()
 *   );
 *   create table cards (
 *     id bigint generated always as identity primary key,
 *     user_id uuid not null references profiles(id) on delete cascade,
 *     card_id text not null,
 *     name text not null,
 *     set_name text,
 *     number text,
 *     image text,
 *     price numeric not null default 0,
 *     created_at timestamptz default now()
 *   );
 *   create table follows (
 *     follower_id uuid references profiles(id) on delete cascade,
 *     following_id uuid references profiles(id) on delete cascade,
 *     created_at timestamptz default now(),
 *     primary key (follower_id, following_id),
 *     check (follower_id <> following_id)
 *   );
 *   create index on cards(user_id);
 *   create index on profiles(total_value desc);
 *   create index on follows(following_id);
 *   -- Storage: create a PUBLIC bucket named "avatars".
 */

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const {
  GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, POKEMONTCG_API_KEY, FRONTEND_ORIGIN,
  GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct',
  PORT = 3000,
} = process.env;

const BADGE_THRESHOLD = 1000;
if (!GROQ_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing GROQ_API_KEY, SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const app = express();
app.use(cors(FRONTEND_ORIGIN ? { origin: FRONTEND_ORIGIN } : {}));
app.use(express.json({ limit: '8mb' }));

/* ---------- helpers ---------- */
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' });
});
const fail = (status, message) => Object.assign(new Error(message), { status });
const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;

// Simple in-memory rate limiter (per IP) for the AI route
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip, now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Slow down, too many scans. Try again in a minute.' });
    arr.push(now); hits.set(k, arr); next();
  };
}
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

// Auth: reads a Supabase access token from "Authorization: Bearer <token>"
async function getUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  await ensureProfile(data.user);
  return data.user;
}
const optionalAuth = wrap(async (req, _res, next) => { req.user = await getUser(req); next(); });
const requireAuth = wrap(async (req, _res, next) => {
  req.user = await getUser(req);
  if (!req.user) throw fail(401, 'Please sign in.');
  next();
});

async function ensureProfile(user) {
  const { data } = await db.from('profiles').select('id').eq('id', user.id).maybeSingle();
  if (data) return;
  let base = (user.user_metadata?.username || (user.email || 'collector').split('@')[0])
    .toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 14) || 'collector';
  if (base.length < 3) base += 'user';
  for (let i = 0; i < 5; i++) {
    const username = i === 0 ? base : base + Math.floor(Math.random() * 9999);
    const { error } = await db.from('profiles').insert({ id: user.id, username });
    if (!error) return;
  }
}

async function recalc(userId) {
  const { data } = await db.from('cards').select('price').eq('user_id', userId);
  const total = (data || []).reduce((a, c) => a + Number(c.price || 0), 0);
  const { data: p } = await db.from('profiles').select('badge').eq('id', userId).single();
  const badge = !!p?.badge || total >= BADGE_THRESHOLD; // once earned, it stays
  const total_value = Math.round(total * 100) / 100;
  await db.from('profiles').update({ total_value, card_count: data?.length || 0, badge }).eq('id', userId);
  return { total_value, card_count: data?.length || 0, badge };
}

async function counts(userId) {
  const [a, b] = await Promise.all([
    db.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
    db.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
  ]);
  return { followers: a.count || 0, following: b.count || 0 };
}

async function followedSet(meId, ids) {
  if (!meId || !ids.length) return new Set();
  const { data } = await db.from('follows').select('following_id').eq('follower_id', meId).in('following_id', ids);
  return new Set((data || []).map(r => r.following_id));
}
async function decorate(rows, meId) {
  const set = await followedSet(meId, rows.map(r => r.id));
  return rows.map(r => ({ ...r, is_following: set.has(r.id), is_me: r.id === meId }));
}

/* ---------- pokemon price data ---------- */
const TCG = 'https://api.pokemontcg.io/v2';
const tcgHeaders = POKEMONTCG_API_KEY ? { 'X-Api-Key': POKEMONTCG_API_KEY } : {};
function priceOf(c) {
  const p = c?.tcgplayer?.prices;
  if (!p) return null;
  const k = Object.values(p)[0];
  const v = k?.market ?? k?.mid ?? null;
  return v == null ? null : Math.round(Number(v) * 100) / 100;
}
const shape = c => ({
  id: c.id, name: c.name, set: c.set?.name, number: c.number, rarity: c.rarity || null,
  image: c.images?.small, image_large: c.images?.large, price: priceOf(c),
});
async function tcgSearch(q, pageSize = 8) {
  const r = await fetch(`${TCG}/cards?pageSize=${pageSize}&q=${encodeURIComponent(q)}`, { headers: tcgHeaders });
  if (!r.ok) throw fail(502, 'Price service is unavailable right now.');
  return ((await r.json()).data || []).map(shape);
}
async function findCards(name, number) {
  const clean = String(name || '').replace(/["\\]/g, '').trim();
  const num = String(number || '').split('/')[0].replace(/^0+/, '').replace(/[^A-Za-z0-9]/g, '');
  if (!clean) return [];
  if (num) {
    const exact = await tcgSearch(`name:"${clean}" number:${num}`);
    if (exact.length) return exact;
  }
  return tcgSearch(`name:"${clean}*"`);
}
async function tcgById(id) {
  const r = await fetch(`${TCG}/cards/${encodeURIComponent(id)}`, { headers: tcgHeaders });
  if (!r.ok) return null;
  return shape((await r.json()).data);
}

/* ---------- groq ---------- */
async function groqIdentify(image) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL, temperature: 0, max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'You are a trading card expert. Identify the Pokemon trading card in this photo. ' +
              'Reply with ONLY a JSON object, no markdown: ' +
              '{"is_card":boolean,"name":string,"number":string (collector number like "4" from "4/102"),' +
              '"set":string,"rarity":string,"about":string (2 short sentences of interesting info for a collector)}. ' +
              'Do NOT include any prices. If it is not a Pokemon card set is_card to false and leave other fields empty.',
          },
          { type: 'image_url', image_url: { url: image } },
        ],
      }],
    }),
  });
  if (!r.ok) throw fail(502, 'The AI scanner is unavailable right now.');
  const text = (await r.json()).choices?.[0]?.message?.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw fail(422, 'Could not read that card. Try better light.');
  try { return JSON.parse(m[0]); } catch { throw fail(422, 'Could not read that card. Try better light.'); }
}

/* ---------- routes ---------- */
app.get('/', (_req, res) => res.json({ ok: true }));
app.get('/health', (_req, res) => res.json({ ok: true, badge_threshold: BADGE_THRESHOLD }));

// Scan: Groq identifies, real price data supplies the value
app.post('/scan', limit(10, 60 * 1000), wrap(async (req, res) => {
  const image = req.body?.image;
  if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) throw fail(400, 'Send a photo as a base64 image.');
  const id = await groqIdentify(image);
  if (!id.is_card || !id.name) throw fail(422, 'That does not look like a Pokemon card.');
  const matches = await findCards(id.name, id.number);
  res.json({
    name: id.name, number: id.number || '', set: id.set || '', rarity: id.rarity || '', about: id.about || '',
    matches, // best match first; each has a price
  });
}));

app.get('/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ cards: [] });
  res.json({ cards: await findCards(q, '') });
}));

/* collection */
app.get('/collection', requireAuth, wrap(async (req, res) => {
  const { data, error } = await db.from('cards').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) throw error;
  const { data: p } = await db.from('profiles').select('total_value,card_count,badge').eq('id', req.user.id).single();
  res.json({ cards: data, total_value: p?.total_value || 0, card_count: p?.card_count || 0, badge: !!p?.badge, badge_threshold: BADGE_THRESHOLD });
}));

app.post('/collection', requireAuth, wrap(async (req, res) => {
  const cardId = req.body?.card_id;
  if (!cardId) throw fail(400, 'card_id is required.');
  const card = await tcgById(cardId); // price comes from the server, never the client
  if (!card) throw fail(404, 'Card not found.');
  const { error } = await db.from('cards').insert({
    user_id: req.user.id, card_id: card.id, name: card.name, set_name: card.set,
    number: card.number, image: card.image, price: card.price || 0,
  });
  if (error) throw error;
  const stats = await recalc(req.user.id);
  res.json({ ok: true, ...stats, badge_threshold: BADGE_THRESHOLD });
}));

app.delete('/collection/:id', requireAuth, wrap(async (req, res) => {
  await db.from('cards').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ ok: true, ...(await recalc(req.user.id)) });
}));

// Re-price everything in the collection with fresh market prices
app.post('/collection/refresh', requireAuth, wrap(async (req, res) => {
  const { data } = await db.from('cards').select('id,card_id').eq('user_id', req.user.id).limit(300);
  const unique = [...new Set((data || []).map(c => c.card_id))];
  const fresh = {};
  for (let i = 0; i < unique.length; i += 5) {
    await Promise.all(unique.slice(i, i + 5).map(async id => { const c = await tcgById(id); if (c?.price != null) fresh[id] = c.price; }));
  }
  for (const c of data || []) if (fresh[c.card_id] != null) await db.from('cards').update({ price: fresh[c.card_id] }).eq('id', c.id);
  res.json({ ok: true, ...(await recalc(req.user.id)) });
}));

/* leaderboard */
app.get('/leaderboard', optionalAuth, wrap(async (req, res) => {
  const lim = Math.min(Number(req.query.limit) || 50, 100);
  const { data, error } = await db.from('profiles')
    .select('id,username,avatar_url,total_value,card_count,badge')
    .gt('card_count', 0).order('total_value', { ascending: false }).limit(lim);
  if (error) throw error;
  const rows = (await decorate(data, req.user?.id)).map((r, i) => ({ ...r, rank: i + 1 }));
  res.json({ leaderboard: rows });
}));

/* me */
app.get('/me', requireAuth, wrap(async (req, res) => {
  const { data: p, error } = await db.from('profiles').select('*').eq('id', req.user.id).single();
  if (error) throw error;
  res.json({ ...p, email: req.user.email, ...(await counts(req.user.id)), badge_threshold: BADGE_THRESHOLD });
}));

app.patch('/me', requireAuth, wrap(async (req, res) => {
  const patch = {};
  if (req.body.username != null) {
    const u = String(req.body.username).trim();
    if (!USERNAME_RE.test(u)) throw fail(400, 'Username must be 3-20 letters, numbers or underscores.');
    patch.username = u.toLowerCase();
  }
  if (req.body.bio != null) patch.bio = String(req.body.bio).slice(0, 160);
  if (!Object.keys(patch).length) throw fail(400, 'Nothing to update.');
  const { data, error } = await db.from('profiles').update(patch).eq('id', req.user.id).select().single();
  if (error) throw fail(error.code === '23505' ? 409 : 400, error.code === '23505' ? 'That username is taken.' : 'Could not update profile.');
  res.json(data);
}));

app.post('/me/avatar', requireAuth, wrap(async (req, res) => {
  const m = String(req.body?.image || '').match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
  if (!m) throw fail(400, 'Send a jpeg, png or webp image.');
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 2 * 1024 * 1024) throw fail(413, 'Image must be under 2 MB.');
  const path = `${req.user.id}/${Date.now()}.${m[2].split('/')[1]}`;
  const up = await db.storage.from('avatars').upload(path, buf, { contentType: m[1], upsert: true });
  if (up.error) throw fail(500, 'Upload failed.');
  const url = db.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  await db.from('profiles').update({ avatar_url: url }).eq('id', req.user.id);
  res.json({ avatar_url: url });
}));

/* profiles, follows, discover */
async function profileByName(name) {
  const { data } = await db.from('profiles').select('id,username,avatar_url,bio,total_value,card_count,badge,created_at').ilike('username', name).maybeSingle();
  if (!data) throw fail(404, 'Profile not found.');
  return data;
}

app.get('/profile/:username', optionalAuth, wrap(async (req, res) => {
  const p = await profileByName(req.params.username);
  const [c, flw] = await Promise.all([counts(p.id), followedSet(req.user?.id, [p.id])]);
  const { data: top } = await db.from('cards').select('name,set_name,image,price').eq('user_id', p.id).order('price', { ascending: false }).limit(6);
  res.json({ ...p, ...c, is_following: flw.has(p.id), is_me: p.id === req.user?.id, top_cards: top || [] });
}));

async function listFollows(req, res, mode) {
  const p = await profileByName(req.params.username);
  const mine = mode === 'followers' ? 'following_id' : 'follower_id';
  const other = mode === 'followers' ? 'follower_id' : 'following_id';
  const { data } = await db.from('follows').select(other).eq(mine, p.id).order('created_at', { ascending: false }).limit(100);
  const ids = (data || []).map(r => r[other]);
  if (!ids.length) return res.json({ users: [] });
  const { data: users } = await db.from('profiles').select('id,username,avatar_url,total_value,badge').in('id', ids);
  res.json({ users: await decorate(users || [], req.user?.id) });
}
app.get('/profile/:username/followers', optionalAuth, wrap((req, res) => listFollows(req, res, 'followers')));
app.get('/profile/:username/following', optionalAuth, wrap((req, res) => listFollows(req, res, 'following')));

app.post('/follow/:userId', requireAuth, wrap(async (req, res) => {
  if (req.params.userId === req.user.id) throw fail(400, 'You cannot follow yourself.');
  const { error } = await db.from('follows').upsert({ follower_id: req.user.id, following_id: req.params.userId });
  if (error) throw fail(404, 'User not found.');
  res.json({ ok: true, is_following: true, ...(await counts(req.params.userId)) });
}));
app.delete('/follow/:userId', requireAuth, wrap(async (req, res) => {
  await db.from('follows').delete().eq('follower_id', req.user.id).eq('following_id', req.params.userId);
  res.json({ ok: true, is_following: false, ...(await counts(req.params.userId)) });
}));

// Discover people: search by username, or suggestions you don't follow yet
app.get('/discover', optionalAuth, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/[%_,()]/g, '');
  let query = db.from('profiles').select('id,username,avatar_url,bio,total_value,card_count,badge').limit(30);
  if (q) query = query.ilike('username', `%${q}%`);
  else query = query.order('total_value', { ascending: false });
  if (req.user) query = query.neq('id', req.user.id);
  const { data, error } = await query;
  if (error) throw error;
  let rows = await decorate(data || [], req.user?.id);
  if (!q) rows = rows.filter(r => !r.is_following);
  res.json({ users: rows });
}));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.listen(PORT, () => console.log(`CardScan server listening on ${PORT}`));
