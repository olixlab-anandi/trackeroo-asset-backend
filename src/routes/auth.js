// src/routes/auth.js
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { q, pool } from '../db.js';
import { ENV } from '../env.js';

const router = Router();

const ALLOWED_PORTAL_ROLES = [
  'super_admin',
  'admin',
  'portal_user',
  'portal_mobile_user',
];

// IMPORTANT: keep these identical for set + clear
export const COOKIE_NAME = ENV.COOKIE_NAME; // e.g., "at.sid"
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: ENV.COOKIE_SECURE, // false on localhost, true in prod HTTPS
  path: '/',
};

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const { rows } = await pool.query(
    `SELECT id, email, password_hash, role, name, is_active
     FROM users WHERE email = $1 LIMIT 1`,
    [String(email).toLowerCase()]
  );
  const user = rows[0];
  if (!user || user.is_active !== true) return res.status(401).json({ error: 'Invalid credentials.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

  const role = user.role;

  // If the role is not allowed for the portal, send to /no-access
  if (!ALLOWED_PORTAL_ROLES.includes(role)) {
    return res.status(401).json({ error: 'Your account is for mobile use only. Please log in via the mobile app.' });
  }

  // include role in the token
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );

  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);

  // CHANGED: if mobile client, also return token in payload
  const client = String(req.headers['x-client'] || '').toLowerCase();
  if (client === 'mobile') {
    return res.json({ id: user.id, user_email: user.email, name: user.name, role: user.role, token });
  }

  res.json({ id: user.id, user_email: user.email, name: user.name, role: user.role });
});


// GET /auth/me   <-- this must be EXACTLY as below (no extra prefix)
router.get('/me', (req, res) => {
  try {
    const cookie = req.cookies?.[COOKIE_NAME];
    if (!cookie) return res.json({ user: null });
    const payload = jwt.verify(cookie, ENV.JWT_SECRET);
    return res.json({ user: payload });
  } catch {
    return res.json({ user: null });
  }
});

router.post('/logout', (req, res) => {
  try {
    res.clearCookie(ENV.COOKIE_NAME, COOKIE_OPTS);
    res.cookie(ENV.COOKIE_NAME, '', { ...COOKIE_OPTS, maxAge: 0, expires: new Date(0) });
    return res.json({ ok: true });
  } catch (e) {
    console.error('Logout error:', e);
    return res.status(500).json({ error: 'Server error.' });
  }
});

export default router;
