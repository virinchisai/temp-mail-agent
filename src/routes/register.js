const express = require('express');
const { randomUUID: uuid } = require('crypto');
const db = require('../db');
const { generateApiKey } = require('../utils/apiKey');
const { requireAuth } = require('../middleware/auth');
const { effectivePhoneProvider } = require('../services/phoneProviders');

const router = express.Router();

// Legacy bootstrap endpoint: instant, no email/password, no CAPTCHA.
// Convenient for local dev, but on a public deployment it's a free bypass
// around every signup guardrail (rate limits aside, a bot can mint
// unlimited accounts here without ever touching /auth/signup). Disabled
// automatically outside development — use /auth/signup instead.
router.post('/register', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(410).json({ error: 'Anonymous registration is disabled — use /api/auth/signup' });
  }
  const { label } = req.body || {};
  const id = uuid();
  const apiKey = generateApiKey();

  db.prepare('INSERT INTO accounts (id, api_key, label, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    apiKey,
    label || null,
    Date.now()
  );

  res.status(201).json({ accountId: id, apiKey });
});

// Lets the dashboard (or any client) validate a stored key and learn
// whether the phone module is backed by real Twilio or the mock provider.
router.get('/me', requireAuth, (req, res) => {
  res.json({
    accountId: req.account.id,
    label: req.account.label,
    email: req.account.email,
    apiKey: req.account.api_key,
    mfaEnabled: Boolean(req.account.mfa_enabled),
    createdAt: req.account.created_at,
    phoneProvider: effectivePhoneProvider(),
  });
});

module.exports = router;
