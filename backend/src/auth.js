// Login med brugernavn + adgangskode og cookie-session i Postgres. Oprettelse kræver
// invitationskoden (INVITE_CODE). Hvad der bevidst er fravalgt, og hvorfor, står under
// "Fase 2" i CLAUDE.md.
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('./db');

// Fejl ved opstart frem for mystisk opførsel senere — som DATABASE_URL i db.js
for (const name of ['SESSION_SECRET', 'INVITE_CODE']) {
  if (!process.env[name]) {
    throw new Error(`${name} mangler. Se backend/.env.example.`);
  }
}

const USERNAME_RE = /^[a-z0-9_.-]{3,30}$/;
const MIN_PASSWORD_LENGTH = 8;
// Lavt med vilje: bcryptjs er ren JS, og højere cost mærkes på Render's gratis CPU
const BCRYPT_COST = 10;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Standarden er hvert ~15. minut, så Neon aldrig når at gå i dvale mens serveren kører.
// Udløbne sessioner afvises alligevel ved opslag; oprydningen sparer kun plads.
const PRUNE_INTERVAL_S = 24 * 60 * 60;

const sessionMiddleware = session({
  // Tabellen oprettes af schema.sql — ikke af createTableIfMissing ved opstart
  store: new PgSession({ pool, pruneSessionInterval: PRUNE_INTERVAL_S }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    // Vores CSRF-beskyttelse: cookien følger ikke med på POST-kald fra andre sites
    sameSite: 'lax',
    // Kræver app.set('trust proxy', 1) bag Render's proxy — ellers sættes den aldrig
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_MS,
  },
});

function requireUser(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Login kræves' });
  req.userId = req.session.userId;
  next();
}

function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim().toLowerCase() : '';
}

// Nyt session-id ved login, så et id plantet før login ikke bliver gyldigt
// (session fixation). express-session's regenerate/save er callback-baserede.
function logIn(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

const router = express.Router();

router.post('/register', async (req, res) => {
  const { password, invite } = req.body || {};
  const username = normalizeUsername(req.body?.username);

  if (invite !== process.env.INVITE_CODE) {
    return res.status(403).json({ error: 'Forkert invitationskode' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'Brugernavnet skal være 3–30 tegn: små bogstaver, tal, punktum, bindestreg eller understreg',
    });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Adgangskoden skal være mindst ${MIN_PASSWORD_LENGTH} tegn` });
  }

  try {
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, hash]
    );
    await logIn(req, rows[0]);
    res.status(201).json({ username: rows[0].username });
  } catch (err) {
    // Unique violation — fanger også to der opretter samme navn samtidig
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Brugernavnet er taget' });
    }
    console.error('Kunne ikke oprette bruger:', err);
    res.status(500).json({ error: 'Kunne ikke oprette brugeren' });
  }
});

router.post('/login', async (req, res) => {
  const { password } = req.body || {};
  const username = normalizeUsername(req.body?.username);
  // Samme svar ved ukendt bruger og forkert adgangskode
  const wrong = () => res.status(401).json({ error: 'Forkert brugernavn eller adgangskode' });
  if (!username || typeof password !== 'string') return wrong();

  try {
    const { rows } = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return wrong();
    await logIn(req, user);
    res.json({ username: user.username });
  } catch (err) {
    console.error('Login fejlede:', err);
    res.status(500).json({ error: 'Login fejlede' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout fejlede:', err);
      return res.status(500).json({ error: 'Logout fejlede' });
    }
    // Uden dette bliver browseren ved med at sende et id der ikke længere findes
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireUser, (req, res) => {
  res.json({ username: req.session.username });
});

module.exports = { sessionMiddleware, requireUser, router };
