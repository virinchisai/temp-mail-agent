const express = require('express');
const { randomUUID: uuid } = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { generateApiKey } = require('../utils/apiKey');
const {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  validateEmail,
  setSessionCookie,
  clearSessionCookie,
  generateBackupCodes,
} = require('../utils/authSecurity');
const bcrypt = require('bcryptjs');

const router = express.Router();

router.post('/auth/signup', async (req, res) => {
  const { email, password, label } = req.body || {};

  const emailError = validateEmail(email);
  if (emailError) return res.status(400).json({ error: emailError });
  const passwordError = validatePasswordStrength(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  const normalizedEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const id = uuid();
  const apiKey = generateApiKey();
  const passwordHash = await hashPassword(password);

  db.prepare(
    `INSERT INTO accounts (id, api_key, label, email, password_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, apiKey, label || null, normalizedEmail, passwordHash, Date.now());

  setSessionCookie(res, id);
  res.status(201).json({ accountId: id, email: normalizedEmail });
});

router.post('/auth/login', async (req, res) => {
  const { email, password, totpCode } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const account = db.prepare('SELECT * FROM accounts WHERE email = ?').get(String(email).trim().toLowerCase());
  // Same generic error whether the email doesn't exist or the password is
  // wrong — don't help an attacker enumerate registered emails.
  const passwordOk = account && (await verifyPassword(password, account.password_hash));
  if (!passwordOk) return res.status(401).json({ error: 'Invalid email or password' });

  if (account.mfa_enabled) {
    if (!totpCode) return res.status(401).json({ error: 'MFA code required', mfaRequired: true });

    const totpOk = speakeasy.totp.verify({
      secret: account.mfa_secret,
      encoding: 'base32',
      token: String(totpCode).trim(),
      window: 1, // tolerate one 30s step of clock drift
    });
    let backupUsed = false;

    if (!totpOk) {
      const backupCodes = JSON.parse(account.mfa_backup_codes || '[]');
      const matchIndex = await findMatchingBackupCode(backupCodes, totpCode);
      if (matchIndex === -1) {
        return res.status(401).json({ error: 'Invalid authentication code', mfaRequired: true });
      }
      backupCodes.splice(matchIndex, 1); // backup codes are single-use
      db.prepare('UPDATE accounts SET mfa_backup_codes = ? WHERE id = ?').run(JSON.stringify(backupCodes), account.id);
      backupUsed = true;
    }

    setSessionCookie(res, account.id);
    return res.json({ accountId: account.id, email: account.email, backupCodeUsed: backupUsed });
  }

  setSessionCookie(res, account.id);
  res.json({ accountId: account.id, email: account.email });
});

async function findMatchingBackupCode(hashedCodes, candidate) {
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await bcrypt.compare(String(candidate).trim(), hashedCodes[i])) return i;
  }
  return -1;
}

router.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

// --- MFA enrollment (requires being logged in already) ---

router.post('/auth/mfa/setup', requireAuth, async (req, res) => {
  if (!req.account.password_hash) {
    return res.status(400).json({ error: 'MFA requires a password-based account — sign up with email/password first' });
  }
  const generated = speakeasy.generateSecret({
    length: 20,
    name: `temp-mail-agent (${req.account.email})`,
  });
  db.prepare('UPDATE accounts SET mfa_secret = ? WHERE id = ?').run(generated.base32, req.account.id);

  const qrDataUrl = await QRCode.toDataURL(generated.otpauth_url);
  res.json({ secret: generated.base32, otpauthUri: generated.otpauth_url, qrDataUrl });
});

router.post('/auth/mfa/verify', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (!req.account.mfa_secret) return res.status(400).json({ error: 'Call mfa/setup first' });

  const ok = speakeasy.totp.verify({
    secret: req.account.mfa_secret,
    encoding: 'base32',
    token: String(code || '').trim(),
    window: 1,
  });
  if (!ok) return res.status(400).json({ error: 'Invalid code — check your authenticator app and try again' });

  const backupCodes = generateBackupCodes();
  const hashedBackupCodes = await Promise.all(backupCodes.map((c) => hashPassword(c)));
  db.prepare('UPDATE accounts SET mfa_enabled = 1, mfa_backup_codes = ? WHERE id = ?').run(
    JSON.stringify(hashedBackupCodes),
    req.account.id
  );
  res.json({ enabled: true, backupCodes });
});

router.post('/auth/mfa/disable', requireAuth, async (req, res) => {
  const { password } = req.body || {};
  const ok = await verifyPassword(password || '', req.account.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });

  db.prepare('UPDATE accounts SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL WHERE id = ?').run(
    req.account.id
  );
  res.json({ enabled: false });
});

module.exports = router;
