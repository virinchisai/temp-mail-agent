const express = require('express');
const { randomUUID: uuid } = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const mailProvider = require('../services/mailProvider');
const { findFirstOtp } = require('../services/otp');

const router = express.Router();
router.use(requireAuth);

const DEFAULT_TTL_MINUTES = 15;
const MAX_TTL_MINUTES = 24 * 60; // 1 day per create/extend call, extend as many times as you like

function serializeMailbox(row) {
  return {
    id: row.id,
    address: row.address,
    parentId: row.parent_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    expired: row.expires_at < Date.now(),
  };
}

function loadOwnedMailbox(req, res) {
  const mailbox = db
    .prepare('SELECT * FROM mailboxes WHERE id = ? AND account_id = ?')
    .get(req.params.id, req.account.id);
  if (!mailbox) {
    res.status(404).json({ error: 'Mailbox not found' });
    return null;
  }
  return mailbox;
}

// Create a new disposable inbox. Pass parentId to create a "child" inbox
// grouped under an existing one (useful for e.g. per-test-run aliases).
router.post('/', async (req, res) => {
  const { ttlMinutes = DEFAULT_TTL_MINUTES, parentId } = req.body || {};
  const ttl = Math.min(Math.max(1, Number(ttlMinutes) || DEFAULT_TTL_MINUTES), MAX_TTL_MINUTES);

  if (parentId) {
    const parent = db
      .prepare('SELECT * FROM mailboxes WHERE id = ? AND account_id = ?')
      .get(parentId, req.account.id);
    if (!parent) return res.status(404).json({ error: 'parentId not found for this account' });
  }

  try {
    const { address, password, token } = await mailProvider.createMailbox();
    const id = uuid();
    const now = Date.now();
    const expiresAt = now + ttl * 60_000;

    db.prepare(
      `INSERT INTO mailboxes (id, account_id, parent_id, address, provider, provider_password, provider_token, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'mailtm', ?, ?, ?, ?)`
    ).run(id, req.account.id, parentId || null, address, password, token, now, expiresAt);

    res.status(201).json(serializeMailbox({ id, address, parent_id: parentId || null, created_at: now, expires_at: expiresAt }));
  } catch (err) {
    console.error('[emails] create failed:', err);
    res.status(502).json({ error: 'Failed to provision mailbox from upstream provider', detail: err.message });
  }
});

router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM mailboxes WHERE account_id = ? ORDER BY created_at DESC')
    .all(req.account.id);
  res.json(rows.map(serializeMailbox));
});

router.get('/:id', (req, res) => {
  const mailbox = loadOwnedMailbox(req, res);
  if (!mailbox) return;
  res.json(serializeMailbox(mailbox));
});

router.get('/:id/messages', async (req, res) => {
  const mailbox = loadOwnedMailbox(req, res);
  if (!mailbox) return;
  if (mailbox.expires_at < Date.now()) {
    return res.status(410).json({ error: 'Mailbox expired' });
  }

  try {
    const { messages, token } = await mailProvider.listMessages(mailbox);
    if (token !== mailbox.provider_token) {
      db.prepare('UPDATE mailboxes SET provider_token = ? WHERE id = ?').run(token, mailbox.id);
    }
    messages.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    res.json({ messages });
  } catch (err) {
    console.error('[emails] fetch messages failed:', err);
    res.status(502).json({ error: 'Failed to fetch messages from upstream provider', detail: err.message });
  }
});

// Convenience endpoint for autofill flows: returns just the latest OTP found.
router.get('/:id/otp', async (req, res) => {
  const mailbox = loadOwnedMailbox(req, res);
  if (!mailbox) return;
  if (mailbox.expires_at < Date.now()) {
    return res.status(410).json({ error: 'Mailbox expired' });
  }

  try {
    const { messages, token } = await mailProvider.listMessages(mailbox);
    if (token !== mailbox.provider_token) {
      db.prepare('UPDATE mailboxes SET provider_token = ? WHERE id = ?').run(token, mailbox.id);
    }
    messages.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    const found = findFirstOtp(messages);
    if (!found) return res.json({ otp: null });
    res.json({ otp: found.otp, from: found.message.from, subject: found.message.subject, receivedAt: found.message.receivedAt });
  } catch (err) {
    console.error('[emails] otp lookup failed:', err);
    res.status(502).json({ error: 'Failed to fetch messages from upstream provider', detail: err.message });
  }
});

router.patch('/:id/extend', (req, res) => {
  const mailbox = loadOwnedMailbox(req, res);
  if (!mailbox) return;

  const { minutes } = req.body || {};
  const add = Number(minutes);
  if (!Number.isFinite(add) || add <= 0) {
    return res.status(400).json({ error: 'minutes must be a positive number' });
  }
  const capped = Math.min(add, MAX_TTL_MINUTES);
  const base = Math.max(mailbox.expires_at, Date.now()); // don't extend from a stale expired timestamp
  const newExpiry = base + capped * 60_000;

  db.prepare('UPDATE mailboxes SET expires_at = ? WHERE id = ?').run(newExpiry, mailbox.id);
  res.json(serializeMailbox({ ...mailbox, expires_at: newExpiry }));
});

router.delete('/:id', async (req, res) => {
  const mailbox = loadOwnedMailbox(req, res);
  if (!mailbox) return;

  await mailProvider.deleteMailbox(mailbox);
  db.prepare('DELETE FROM mailboxes WHERE id = ?').run(mailbox.id);
  res.status(204).end();
});

module.exports = router;
