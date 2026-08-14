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
    const err = new Error(`mail.tm ${opts.method || 'GET'} ${pathname} -> ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// Domains rarely change; avoid re-fetching on every dashboard load.
let domainCache = { domains: [], fetchedAt: 0 };
const DOMAIN_CACHE_TTL_MS = 5 * 60_000;

async function listDomains() {
  if (domainCache.domains.length && Date.now() - domainCache.fetchedAt < DOMAIN_CACHE_TTL_MS) {
    return domainCache.domains;
  }
  const data = await apiFetch('/domains?page=1');
  const domains = (data['hydra:member'] || []).filter((d) => d.isActive).map((d) => d.domain);
  domainCache = { domains, fetchedAt: Date.now() };
  return domains;
}

async function resolveDomain(requested) {
  const domains = await listDomains();
  if (!domains.length) throw new Error('No active mail.tm domains available right now');
  if (!requested) return domains[0];
  if (!domains.includes(requested)) {
    const err = new Error(`"${requested}" isn't a currently active domain`);
    err.userFacing = true;
    throw err;
  }
  return requested;
}

const PREFIX_PATTERN = /^[a-z0-9._-]{1,32}$/;

function sanitizePrefix(prefix) {
  const cleaned = String(prefix).trim().toLowerCase();
  if (!PREFIX_PATTERN.test(cleaned)) {
    const err = new Error('Prefix must be 1-32 characters: letters, numbers, dots, underscores, or hyphens only');
    err.userFacing = true;
    throw err;
  }
  return cleaned;
}

async function createMailbox({ prefix, domain } = {}) {
  const resolvedDomain = await resolveDomain(domain);
  const localPart = prefix ? sanitizePrefix(prefix) : randomLocalPart();
  const address = `${localPart}@${resolvedDomain}`;
  const password = generatePassword();
  try {
    await apiFetch('/accounts', {
      method: 'POST',
      body: JSON.stringify({ address, password }),
    });
  } catch (err) {
    if (err.status === 422 || err.status === 409) {
      const taken = new Error(`"${address}" is already taken — try a different prefix`);
      taken.userFacing = true;
      taken.httpStatus = 400;
      throw taken;
    }
    if (err.status === 429) {
      const limited = new Error('mail.tm rate-limited this request — wait a few seconds and try again');
      limited.userFacing = true;
      limited.httpStatus = 429;
      throw limited;
    }
    throw err;
  }
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

module.exports = { createMailbox, listMessages, deleteMailbox, login, listDomains };
