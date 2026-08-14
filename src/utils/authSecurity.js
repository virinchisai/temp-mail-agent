const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const BCRYPT_ROUNDS = 12;
const SESSION_COOKIE = 'tma_session';
const SESSION_TTL = '12h';

// A real secret is required in production so sessions can't be forged.
// In dev, fall back to a random one-off secret — fine locally, since it
// just means everyone's session resets when the server restarts.
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('SESSION_SECRET must be set in production — see .env.example'); })()
    : crypto.randomBytes(32).toString('hex'));

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters long';
  }
  return null;
}

function validateEmail(email) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return 'Enter a valid email address';
  }
  return null;
}

function issueSessionToken(accountId) {
  return jwt.sign({ sub: accountId }, SESSION_SECRET, { expiresIn: SESSION_TTL });
}

function verifySessionToken(token) {
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    return payload.sub;
  } catch {
    return null;
  }
}

function setSessionCookie(res, accountId) {
  res.cookie(SESSION_COOKIE, issueSessionToken(accountId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE);
}

function generateBackupCodes(count = 8) {
  return Array.from({ length: count }, () => crypto.randomBytes(5).toString('hex'));
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  validateEmail,
  issueSessionToken,
  verifySessionToken,
  setSessionCookie,
  clearSessionCookie,
  generateBackupCodes,
};
