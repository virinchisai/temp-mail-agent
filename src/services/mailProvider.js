// Wraps the free mail.tm public API (https://docs.mail.tm) to provision
// real, receivable disposable mailboxes without needing to own a domain
// or run an SMTP server ourselves.
const { generatePassword, randomLocalPart } = require('../utils/apiKey');

const API_BASE = process.env.MAILTM_API_BASE || 'https://api.mail.tm';

async function apiFetch(pathname, opts = {}) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`mail.tm ${opts.method || 'GET'} ${pathname} -> ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function pickDomain() {
  const data = await apiFetch('/domains?page=1');
  const domain = (data['hydra:member'] || []).find((d) => d.isActive);
  if (!domain) throw new Error('No active mail.tm domains available right now');
  return domain.domain;
}

async function createMailbox() {
  const domain = await pickDomain();
  const address = `${randomLocalPart()}@${domain}`;
  const password = generatePassword();
  await apiFetch('/accounts', {
    method: 'POST',
    body: JSON.stringify({ address, password }),
  });
  const token = await login(address, password);
  return { address, password, token };
}

async function login(address, password) {
  const data = await apiFetch('/token', {
    method: 'POST',
    body: JSON.stringify({ address, password }),
  });
  return data.token;
}

// mail.tm tokens are short-lived JWTs; re-auth transparently if a call 401s.
// Returns { data, token } — token is whatever token actually worked, so
// callers can persist a refreshed one back to the DB.
async function withFreshToken(mailbox, fn) {
  try {
    const data = await fn(mailbox.provider_token);
    return { data, token: mailbox.provider_token };
  } catch (err) {
    if (!String(err.message).includes('401')) throw err;
    const token = await login(mailbox.address, mailbox.provider_password);
    const data = await fn(token);
    return { data, token };
  }
}

async function listMessages(mailbox) {
  const { data: full, token } = await withFreshToken(mailbox, async (token) => {
    const data = await apiFetch('/messages?page=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const summaries = data['hydra:member'] || [];
    return Promise.all(
      summaries.map((m) =>
        apiFetch(`/messages/${m.id}`, { headers: { Authorization: `Bearer ${token}` } })
      )
    );
  });
  const messages = full.map((m) => ({
    id: m.id,
    from: m.from?.address,
    subject: m.subject,
    text: m.text || m.intro || '',
    html: Array.isArray(m.html) ? m.html.join('\n') : m.html || null,
    receivedAt: m.createdAt,
  }));
  return { messages, token };
}

async function deleteMailbox(mailbox) {
  try {
    await withFreshToken(mailbox, async (token) => {
      const me = await apiFetch('/me', { headers: { Authorization: `Bearer ${token}` } });
      await apiFetch(`/accounts/${me.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    });
  } catch (err) {
    // Best-effort cleanup only — provider account expires on its own anyway.
    console.warn(`[mailProvider] cleanup failed for ${mailbox.address}: ${err.message}`);
  }
}

module.exports = { createMailbox, listMessages, deleteMailbox, login };
