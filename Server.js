const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const app = express();
app.use(express.json());
app.use(express.static('public'));

const ADMIN_PASS = process.env.ADMIN_PASS || '53';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS players (
    name TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    coins INT DEFAULT 0,
    best_time REAL DEFAULT 0,
    skins TEXT[] DEFAULT ARRAY['classico'],
    equipped TEXT DEFAULT 'classico',
    banned BOOLEAN DEFAULT FALSE
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS codes (
    code TEXT PRIMARY KEY,
    reward_type TEXT NOT NULL,
    reward_value TEXT NOT NULL,
    stock INT NOT NULL,
    redeemed_by TEXT[] DEFAULT ARRAY[]::TEXT[]
  )`);
}

async function auth(req, res, next) {
  const { name, token } = req.body;
  if (!name || !token) return res.status(401).json({ error: 'Sem login' });
  const r = await pool.query('SELECT * FROM players WHERE name=$1 AND token=$2', [name, token]);
  if (!r.rows[0]) return res.status(401).json({ error: 'Login inválido' });
  if (r.rows[0].banned) return res.status(403).json({ error: 'Você está banido' });
  req.player = r.rows[0];
  next();
}

function adminOnly(req, res, next) {
  if (req.body.adminPass !== ADMIN_PASS) return res.status(403).json({ error: 'Senha errada' });
  next();
}

app.post('/api/login', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 16);
  if (name.length < 3) return res.status(400).json({ error: 'Nome muito curto' });
  const r = await pool.query('SELECT * FROM players WHERE name=$1', [name]);
  if (r.rows[0]) {
    if (r.rows[0].token !== req.body.token) return res.status(401).json({ error: 'Nome já em uso' });
    if (r.rows[0].banned) return res.status(403).json({ error: 'Você está banido' });
    return res.json({ player: r.rows[0] });
  }
  const token = crypto.randomBytes(16).toString('hex');
  const ins = await pool.query('INSERT INTO players(name, token) VALUES($1,$2) RETURNING *', [name, token]);
  res.json({ player: ins.rows[0] });
});

app.post('/api/me', auth, (req, res) => res.json({ player: req.player }));

app.post('/api/finish', auth, async (req, res) => {
  const t = Math.max(0, Math.min(Number(req.body.time) || 0, 3600));
  const earned = Math.floor(t) + (t >= 30 ? 20 : 0) + (t >= 60 ? 50 : 0) + (t >= 120 ? 150 : 0);
  const best = Math.max(req.player.best_time, t);
  await pool.query('UPDATE players SET coins=coins+$1, best_time=$2 WHERE name=$3', [earned, best, req.player.name]);
  res.json({ earned, best });
});

app.get('/api/ranking', async (req, res) => {
  const top = await pool.query('SELECT name, best_time FROM players WHERE banned=false ORDER BY best_time DESC LIMIT 15');
  res.json({ top: top.rows });
});

app.post('/api/rank-of-me', auth, async (req, res) => {
  const r = await pool.query('SELECT COUNT(*)::int AS c FROM players WHERE banned=false AND best_time > $1', [req.player.best_time]);
  const pos = r.rows[0].c + 1;
  res.json({ position: pos > 100 ? '100+' : String(pos) });
});

app.post('/api/buy-skin', auth, async (req, res) => {
  const { skinId, price } = req.body;
  const p = req.player;
  if (p.skins.includes(skinId)) return res.status(400).json({ error: 'Você já tem' });
  if (p.coins < price) return res.status(400).json({ error: 'Moedas insuficientes' });
  await pool.query('UPDATE players SET coins=coins-$1, skins=array_append(skins,$2) WHERE name=$3', [price, skinId, p.name]);
  res.json({ ok: true });
});

app.post('/api/equip', auth, async (req, res) => {
  if (!req.player.skins.includes(req.body.skinId)) return res.status(400).json({ error: 'Skin não é sua' });
  await pool.query('UPDATE players SET equipped=$1 WHERE name=$2', [req.body.skinId, req.player.name]);
  res.json({ ok: true });
});

app.post('/api/redeem', auth, async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const r = await pool.query('SELECT * FROM codes WHERE code=$1', [code]);
  const c = r.rows[0];
  if (!c) return res.status(404).json({ error: 'Código não existe' });
  if (c.stock <= 0) return res.status(400).json({ error: 'Código esgotado' });
  if (c.redeemed_by.includes(req.player.name)) return res.status(400).json({ error: 'Você já usou este código' });
  await pool.query('UPDATE codes SET stock=stock-1, redeemed_by=array_append(redeemed_by,$1) WHERE code=$2', [req.player.name, code]);
  if (c.reward_type === 'coins') {
    await pool.query('UPDATE players SET coins=coins+$1 WHERE name=$2', [parseInt(c.reward_value), req.player.name]);
  } else if (!req.player.skins.includes(c.reward_value)) {
    await pool.query('UPDATE players SET skins=array_append(skins,$1) WHERE name=$2', [c.reward_value, req.player.name]);
  }
  res.json({ ok: true, rewardType: c.reward_type, rewardValue: c.reward_value });
});

app.post('/api/admin/check', adminOnly, (req, res) => res.json({ ok: true }));

app.post('/api/admin/players', adminOnly, async (req, res) => {
  const r = await pool.query('SELECT name, coins, best_time, banned FROM players ORDER BY best_time DESC LIMIT 200');
  res.json({ players: r.rows });
});

app.post('/api/admin/give-skin', adminOnly, async (req, res) => {
  await pool.query('UPDATE players SET skins=array_append(skins,$1) WHERE name=$2 AND NOT ($1 = ANY(skins))', [req.body.skinId, req.body.target]);
  res.json({ ok: true });
});

app.post('/api/admin/give-coins', adminOnly, async (req, res) => {
  await pool.query('UPDATE players SET coins=coins+$1 WHERE name=$2', [parseInt(req.body.amount) || 0, req.body.target]);
  res.json({ ok: true });
});

app.post('/api/admin/ban', adminOnly, async (req, res) => {
  await pool.query('UPDATE players SET banned=$1 WHERE name=$2', [!!req.body.banned, req.body.target]);
  res.json({ ok: true });
});

app.post('/api/admin/create-code', adminOnly, async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const { rewardType, rewardValue } = req.body;
  const stock = parseInt(req.body.stock) || 1;
  if (!code || !['coins', 'skin'].includes(rewardType)) return res.status(400).json({ error: 'Dados inválidos' });
  await pool.query(
    'INSERT INTO codes(code, reward_type, reward_value, stock) VALUES($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET reward_type=$2, reward_value=$3, stock=$4',
    [code, rewardType, String(rewardValue), stock]
  );
  res.json({ ok: true });
});

app.post('/api/admin/codes', adminOnly, async (req, res) => {
  const r = await pool.query('SELECT code, reward_type, reward_value, stock FROM codes');
  res.json({ codes: r.rows });
});

initDb().then(() => {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Rodando na porta ' + port));
});
