// Usuarios, contraseñas y sesiones.
const crypto = require('crypto');
const { promisify } = require('util');
const store = require('./store');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'svc_session';
const SESSION_DAYS = 14;
const ROLES = ['admin', 'vendedor'];

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
async function verifyPassword(pw, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
function passwordError(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (pw.length > 200) return 'La contraseña es demasiado larga.';
  return null;
}
const normEmail = e => (typeof e === 'string' ? e.trim().toLowerCase() : '');
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const publicUser = u => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active !== false, createdAt: u.createdAt });

async function findByEmail(email) {
  const users = await store.all('users');
  return users.find(u => normEmail(u.email) === email) || null;
}

// ----- sesiones -----
const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');
function readToken(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}
async function createSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  await store.put('sessions', { id: tokenHash(token), userId: user.id, expires });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, expires: new Date(expires), path: '/' });
}
async function destroySession(req, res) {
  const t = readToken(req);
  if (t) await store.del('sessions', tokenHash(t));
  res.clearCookie(COOKIE, { path: '/' });
}
async function loadUser(req, _res, next) {
  try {
    const t = readToken(req);
    if (t) {
      const s = await store.get('sessions', tokenHash(t));
      if (s && s.expires > Date.now()) {
        const u = await store.get('users', s.userId);
        if (u && u.active !== false) req.user = u;
      } else if (s) await store.del('sessions', s.id);
    }
    next();
  } catch (e) { next(e); }
}
async function cleanSessions() {
  const now = Date.now();
  for (const s of await store.all('sessions')) if (s.expires < now) await store.del('sessions', s.id);
}

// Crea el administrador inicial (INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD) si no hay ninguno.
async function ensureInitialAdmin() {
  const users = await store.all('users');
  if (users.some(u => u.role === 'admin' && u.active !== false)) return;
  const email = normEmail(process.env.INITIAL_ADMIN_EMAIL);
  const pw = process.env.INITIAL_ADMIN_PASSWORD;
  if (!email || !pw) { console.warn('No hay administrador: cargá INITIAL_ADMIN_EMAIL e INITIAL_ADMIN_PASSWORD.'); return; }
  const err = passwordError(pw) || (validEmail(email) ? null : 'email inválido');
  if (err) { console.error('No se creó el administrador inicial: ' + err); return; }
  const existing = users.find(u => normEmail(u.email) === email);
  const user = Object.assign(existing || { id: 'u-' + crypto.randomBytes(6).toString('hex'), name: 'Administrador', email, createdAt: new Date().toISOString() },
    { role: 'admin', active: true, passwordHash: await hashPassword(pw) });
  await store.put('users', user);
  console.log('Administrador inicial creado: ' + email);
}

// Freno simple contra intentos de clave repetidos (por IP + email).
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now(), a = attempts.get(key);
  if (!a || now - a.first > 15 * 60e3) return false;
  return a.count >= 8;
}
function noteFailure(key) {
  const now = Date.now(), a = attempts.get(key);
  if (!a || now - a.first > 15 * 60e3) attempts.set(key, { first: now, count: 1 });
  else a.count++;
}

module.exports = {
  ROLES, hashPassword, verifyPassword, passwordError, normEmail, validEmail, publicUser, findByEmail,
  createSession, destroySession, loadUser, cleanSessions, ensureInitialAdmin, tooManyAttempts, noteFailure,
  clearFailures: key => attempts.delete(key)
};
