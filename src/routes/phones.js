const express = require('express');
const { randomUUID: uuid } = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resolveProvider } = require('../services/phoneProviders');
const { findFirstOtp } = require('../services/otp');

const router = express.Router();
router.use(requireAuth);

const DEFAULT_TTL_MINUTES = 15;
const MAX_TTL_MINUTES = 24 * 60;

function serializePhone(row) {
  return {
    id: row.id,
    number: row.number,
    provider: row.provider,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    expired: row.expires_at < Date.now(),
  };
}

function loadOwnedPhone(req, res) {
  const phone = db
    .prepare('SELECT * FROM phone_numbers WHERE id = ? AND account_id = ?')
    .get(req.params.id, req.account.id);
  if (!phone) {
    res.status(404).json({ error: 'Phone number not found' });
    return null;
  }
  return phone;
}

router.post('/', async (req, res) => {
  const { ttlMinutes = DEFAULT_TTL_MINUTES, provider: providerName } = req.body || {};
  const ttl = Math.min(Math.max(1, Number(ttlMinutes) || DEFAULT_TTL_MINUTES), MAX_TTL_MINUTES);

  try {
    const provider = resolveProvider(providerName);
    const { number, providerSid } = await provider.provisionNumber();
    const id = uuid();
    const now = Date.now();
    const expiresAt = now + ttl * 60_000;

    db.prepare(
      `INSERT INTO phone_numbers (id, account_id, provider, provider_sid, number, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.account.id, provider.name, providerSid || null, number, now, expiresAt);

    res.status(201).json(serializePhone({ id, number, provider: provider.name, created_at: now, expires_at: expiresAt }));
  } catch (err) {
    console.error('[phones] create failed:', err);
    res.status(502).json({ error: 'Failed to provision phone number', detail: err.message });
  }
});

router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM phone_numbers WHERE account_id = ? ORDER BY created_at DESC')
    .all(req.account.id);
  res.json(rows.map(serializePhone));
});

router.get('/:id', (req, res) => {
  const phone = loadOwnedPhone(req, res);
  if (!phone) return;
  res.json(serializePhone(phone));
});

router.get('/:id/messages', async (req, res) => {
  const phone = loadOwnedPhone(req, res);
  if (!phone) return;
  if (phone.expires_at < Date.now()) return res.status(410).json({ error: 'Phone number expired' });

  try {
    const provider = resolveProvider(phone.provider);
    const messages = await provider.listMessages(phone);
    messages.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    res.json({ messages });
  } catch (err) {
    console.error('[phones] fetch messages failed:', err);
    res.status(502).json({ error: 'Failed to fetch SMS from provider', detail: err.message });
  }
});

router.get('/:id/otp', async (req, res) => {
  const phone = loadOwnedPhone(req, res);
  if (!phone) return;
  if (phone.expires_at < Date.now()) return res.status(410).json({ error: 'Phone number expired' });

  try {
    const provider = resolveProvider(phone.provider);
    const messages = await provider.listMessages(phone);
    messages.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    const found = findFirstOtp(messages);
    if (!found) return res.json({ otp: null });
    res.json({ otp: found.otp, from: found.message.from, receivedAt: found.message.receivedAt });
  } catch (err) {
    console.error('[phones] otp lookup failed:', err);
    res.status(502).json({ error: 'Failed to fetch SMS from provider', detail: err.message });
  }
});

router.patch('/:id/extend', (req, res) => {
  const phone = loadOwnedPhone(req, res);
  if (!phone) return;

  const { minutes } = req.body || {};
  const add = Number(minutes);
  if (!Number.isFinite(add) || add <= 0) {
    return res.status(400).json({ error: 'minutes must be a positive number' });
  }
  const capped = Math.min(add, MAX_TTL_MINUTES);
  const base = Math.max(phone.expires_at, Date.now());
  const newExpiry = base + capped * 60_000;

  db.prepare('UPDATE phone_numbers SET expires_at = ? WHERE id = ?').run(newExpiry, phone.id);
  res.json(serializePhone({ ...phone, expires_at: newExpiry }));
});

router.delete('/:id', async (req, res) => {
  const phone = loadOwnedPhone(req, res);
  if (!phone) return;

  try {
    const provider = resolveProvider(phone.provider);
    await provider.releaseNumber(phone);
  } catch (err) {
    console.warn('[phones] release failed:', err.message);
  }
  db.prepare('DELETE FROM phone_numbers WHERE id = ?').run(phone.id);
  res.status(204).end();
});

module.exports = router;
