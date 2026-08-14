(() => {
  'use strict';

  const STORAGE_KEY = 'tma_apiKey'; // only used for the "paste an API key" fallback path

  const state = {
    apiKey: null,
    usingApiKeyMode: false, // true = paste-key auth, false = cookie session from login/signup
    account: null,
    emails: [],
    phones: [],
    // per-item ephemeral UI state, keyed by id
    ui: new Map(),
  };

  let mfaSetupData = null; // { secret, otpauthUri, qrDataUrl } while mid-enrollment

  const LIVE_POLL_MS = 4000;

  // Every inbox/number auto-watches itself as soon as it exists — no click
  // required. `expanded: true` so mail is visible immediately too.
  function uiFor(id) {
    if (!state.ui.has(id)) {
      state.ui.set(id, {
        expanded: true,
        live: false,
        watchTimer: null,
        otp: null,
        lastOtpSeen: null,
        messages: null,
        loadingMessages: false,
      });
    }
    return state.ui.get(id);
  }

  // ---------- helpers ----------

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtRemaining(expiresAt) {
    const ms = expiresAt - Date.now();
    if (ms <= 0) return { text: 'expired', cls: 'expired' };
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const text = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    const cls = ms < 60_000 ? 'warn' : '';
    return { text: `expires in ${text}`, cls };
  }

  function toast(message, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`.trim();
    el.textContent = message;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      // Same-origin requests send cookies by default — this is what carries
      // the session for signup/login. x-api-key (paste-key mode) overrides it.
      headers: {
        'Content-Type': 'application/json',
        ...(state.apiKey ? { 'x-api-key': state.apiKey } : {}),
        ...(opts.headers || {}),
      },
    });
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function copyToClipboard(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${label}`, 'success');
    } catch {
      toast('Could not copy — copy manually', 'error');
    }
  }

  // ---------- gate (signup / login / MFA / paste key) ----------

  async function tryRestoreSession() {
    // A previously-pasted API key takes priority if present.
    const savedKey = localStorage.getItem(STORAGE_KEY);
    if (savedKey) {
      state.apiKey = savedKey;
      try {
        state.account = await api('/api/me');
        state.usingApiKeyMode = true;
        showDashboard();
        await refreshAll();
        return;
      } catch {
        state.apiKey = null;
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    // Otherwise, try the session cookie from a prior login/signup.
    try {
      state.account = await api('/api/me');
      state.usingApiKeyMode = false;
      showDashboard();
      await refreshAll();
    } catch {
      showGate();
    }
  }

  function showGate(message) {
    document.getElementById('gate').classList.remove('hidden');
    document.getElementById('dashboard').classList.add('hidden');
    const err = document.getElementById('gateError');
    if (message) { err.textContent = message; err.classList.remove('hidden'); }
    else { err.classList.add('hidden'); }
  }

  function switchGateTab(tab) {
    const isLogin = tab === 'login';
    document.getElementById('tabLogin').classList.toggle('active', isLogin);
    document.getElementById('tabSignup').classList.toggle('active', !isLogin);
    document.getElementById('loginForm').classList.toggle('hidden', !isLogin);
    document.getElementById('signupForm').classList.toggle('hidden', isLogin);
    showGate();
  }

  function showDashboard() {
    document.getElementById('gate').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    document.getElementById('accountLabel').textContent =
      state.account.email || state.account.label || '(unlabeled account)';

    const mfaBadge = document.getElementById('mfaBadge');
    mfaBadge.textContent = state.account.mfaEnabled ? 'MFA on' : 'MFA off';
    mfaBadge.className = `badge ${state.account.mfaEnabled ? 'on' : 'off'}`;

    const phoneBadge = document.getElementById('phoneProviderBadge');
    phoneBadge.textContent = state.account.phoneProvider === 'twilio' ? 'phones: twilio' : 'phones: mock';
    phoneBadge.className = `badge ${state.account.phoneProvider}`;

    document.getElementById('apiKeyDisplay').dataset.full = state.account.apiKey;
    setKeyMasked(true);
  }

  async function handleSignup(e) {
    e.preventDefault();
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    const label = document.getElementById('signupLabel').value.trim();
    try {
      await api('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ email, password, label: label || undefined }),
      });
      state.account = await api('/api/me');
      state.usingApiKeyMode = false;
      toast('Account created', 'success');
      showDashboard();
      await refreshAll();
    } catch (err) {
      showGate(err.message);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const totpCode = document.getElementById('loginMfaCode').value.trim();
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, totpCode: totpCode || undefined }),
      });
      state.account = await api('/api/me');
      state.usingApiKeyMode = false;
      toast('Logged in', 'success');
      showDashboard();
      await refreshAll();
    } catch (err) {
      if (err.data?.mfaRequired) document.getElementById('loginMfaBlock').classList.remove('hidden');
      showGate(err.message);
    }
  }

  async function usePastedKey() {
    const key = document.getElementById('pasteKey').value.trim();
    if (!key) return showGate('Paste a key first.');
    state.apiKey = key;
    try {
      state.account = await api('/api/me');
      state.usingApiKeyMode = true;
      localStorage.setItem(STORAGE_KEY, state.apiKey);
      toast('Signed in', 'success');
      showDashboard();
      await refreshAll();
    } catch (err) {
      state.apiKey = null;
      showGate(`Invalid key: ${err.message}`);
    }
  }

  async function handleLogout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* best effort */ }
    for (const ui of state.ui.values()) if (ui.watchTimer) clearInterval(ui.watchTimer);
    state.ui.clear();
    state.apiKey = null;
    state.account = null;
    state.emails = [];
    state.phones = [];
    state.usingApiKeyMode = false;
    localStorage.removeItem(STORAGE_KEY);
    document.getElementById('loginMfaBlock').classList.add('hidden');
    document.getElementById('mfaPanel').classList.add('hidden');
    showGate();
  }

  function setKeyMasked(masked) {
    const el = document.getElementById('apiKeyDisplay');
    el.textContent = masked ? '••••••••••••••••' : el.dataset.full;
  }

  // ---------- MFA management panel ----------

  function toggleMfaPanel() {
    const panel = document.getElementById('mfaPanel');
    const willShow = panel.classList.contains('hidden');
    panel.classList.toggle('hidden');
    if (willShow) { mfaSetupData = null; renderMfaPanel(); }
  }

  function renderMfaPanel() {
    const root = document.getElementById('mfaPanelContent');

    if (!state.account.email) {
      root.innerHTML = `
        <div class="mfa-panel-card">
          <h3>Security</h3>
          <p class="muted">MFA is only available for email/password accounts — this session is using an API key directly.</p>
        </div>`;
      return;
    }

    if (state.account.mfaEnabled) {
      root.innerHTML = `
        <div class="mfa-panel-card">
          <h3>Two-factor authentication</h3>
          <p class="muted">Enabled for ${escapeHtml(state.account.email)}.</p>
          <div class="gate-block">
            <label for="mfaDisablePassword">Password to confirm</label>
            <input id="mfaDisablePassword" type="password" autocomplete="current-password" />
            <button id="mfaDisableBtn" class="small danger">Disable MFA</button>
          </div>
        </div>`;
      document.getElementById('mfaDisableBtn').addEventListener('click', disableMfa);
      return;
    }

    if (mfaSetupData) {
      root.innerHTML = `
        <div class="mfa-panel-card">
          <h3>Set up two-factor authentication</h3>
          <p class="muted">Scan with an authenticator app (Google Authenticator, 1Password, Authy, etc):</p>
          <img class="mfa-qr" src="${mfaSetupData.qrDataUrl}" alt="MFA enrollment QR code" />
          <p class="muted">Or enter manually: <code>${escapeHtml(mfaSetupData.secret)}</code></p>
          <div class="gate-block">
            <label for="mfaVerifyCode">Enter the 6-digit code</label>
            <input id="mfaVerifyCode" type="text" inputmode="numeric" autocomplete="one-time-code" />
            <button id="mfaVerifyBtn" class="primary small">Confirm</button>
            <button id="mfaCancelBtn" class="small ghost" type="button">Cancel</button>
          </div>
        </div>`;
      document.getElementById('mfaVerifyBtn').addEventListener('click', verifyMfaSetup);
      document.getElementById('mfaCancelBtn').addEventListener('click', () => { mfaSetupData = null; renderMfaPanel(); });
      return;
    }

    root.innerHTML = `
      <div class="mfa-panel-card">
        <h3>Two-factor authentication</h3>
        <p class="muted">Not enabled for ${escapeHtml(state.account.email)}.</p>
        <button id="mfaEnableBtn" class="primary small">Enable MFA</button>
      </div>`;
    document.getElementById('mfaEnableBtn').addEventListener('click', startMfaSetup);
  }

  async function startMfaSetup() {
    try {
      mfaSetupData = await api('/api/auth/mfa/setup', { method: 'POST' });
      renderMfaPanel();
    } catch (err) {
      toast(`Could not start MFA setup: ${err.message}`, 'error');
    }
  }

  async function verifyMfaSetup() {
    const code = document.getElementById('mfaVerifyCode').value.trim();
    try {
      const data = await api('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ code }) });
      mfaSetupData = null;
      state.account.mfaEnabled = true;
      document.getElementById('mfaBadge').textContent = 'MFA on';
      document.getElementById('mfaBadge').className = 'badge on';
      showBackupCodes(data.backupCodes);
      toast('MFA enabled', 'success');
    } catch (err) {
      toast(`Verification failed: ${err.message}`, 'error');
    }
  }

  function showBackupCodes(codes) {
    const root = document.getElementById('mfaPanelContent');
    root.innerHTML = `
      <div class="mfa-panel-card">
        <h3>Save your backup codes</h3>
        <p class="muted">Each works once, in place of an authenticator code, if you lose access to your app. This is the only time they're shown — store them somewhere safe.</p>
        <div class="backup-codes">${codes.map((c) => `<span>${escapeHtml(c)}</span>`).join('')}</div>
        <button id="mfaBackupDoneBtn" class="primary small">I've saved these</button>
      </div>`;
    document.getElementById('mfaBackupDoneBtn').addEventListener('click', renderMfaPanel);
  }

  async function disableMfa() {
    const password = document.getElementById('mfaDisablePassword').value;
    try {
      await api('/api/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ password }) });
      state.account.mfaEnabled = false;
      document.getElementById('mfaBadge').textContent = 'MFA off';
      document.getElementById('mfaBadge').className = 'badge off';
      renderMfaPanel();
      toast('MFA disabled', 'success');
    } catch (err) {
      toast(`Could not disable MFA: ${err.message}`, 'error');
    }
  }

  // ---------- data refresh ----------

  async function refreshAll() {
    await Promise.all([refreshEmails(), refreshPhones()]);
  }

  async function refreshEmails() {
    try {
      state.emails = await api('/api/emails');
      for (const item of state.emails) if (!item.expired) startLive(item.id, 'emails');
      renderEmails();
    } catch (err) {
      toast(`Failed to load inboxes: ${err.message}`, 'error');
    }
  }

  async function refreshPhones() {
    try {
      state.phones = await api('/api/phones');
      for (const item of state.phones) if (!item.expired) startLive(item.id, 'phones');
      renderPhones();
    } catch (err) {
      toast(`Failed to load phone numbers: ${err.message}`, 'error');
    }
  }

  // ---------- email actions ----------

  async function createEmail(parentId) {
    const ttlMinutes = Number(document.getElementById('emailTtl').value) || 15;
    try {
      const item = await api('/api/emails', { method: 'POST', body: JSON.stringify({ ttlMinutes, parentId }) });
      toast(parentId ? 'Child inbox created' : 'Inbox created', 'success');
      await refreshEmails();
      startLive(item.id, 'emails'); // in case refreshEmails() lands before render — cheap no-op if already running
    } catch (err) {
      toast(`Create failed: ${err.message}`, 'error');
    }
  }

  async function extendEmail(id, minutes) {
    try {
      await api(`/api/emails/${id}/extend`, { method: 'PATCH', body: JSON.stringify({ minutes }) });
      toast(`Extended +${minutes}m`, 'success');
      await refreshEmails();
    } catch (err) {
      toast(`Extend failed: ${err.message}`, 'error');
    }
  }

  async function deleteEmail(id) {
    const ui = uiFor(id);
    if (ui.watchTimer) clearInterval(ui.watchTimer);
    state.ui.delete(id);
    try {
      await api(`/api/emails/${id}`, { method: 'DELETE' });
      toast('Inbox deleted', 'success');
      await refreshEmails();
    } catch (err) {
      toast(`Delete failed: ${err.message}`, 'error');
    }
  }

  // Fetches both the message list and the extracted OTP for one item, and
  // re-renders. Runs on a timer once `startLive` kicks it off — this is
  // what makes mail "just show up" with no click.
  async function fetchLiveTick(id, kind) {
    const ui = uiFor(id);
    if (!ui.messages) { ui.loadingMessages = true; render(kind); }
    try {
      const [msgData, otpData] = await Promise.all([
        api(`/api/${kind}/${id}/messages`),
        api(`/api/${kind}/${id}/otp`),
      ]);
      ui.messages = msgData.messages;
      ui.loadingMessages = false;
      if (otpData.otp && otpData.otp !== ui.lastOtpSeen) {
        ui.otp = otpData;
        ui.lastOtpSeen = otpData.otp;
        toast(`OTP received: ${otpData.otp}`, 'success');
      }
      render(kind);
    } catch (err) {
      ui.loadingMessages = false;
      // Mailbox genuinely gone — stop hammering an endpoint that'll never
      // succeed again. Any other error (network hiccup, etc.) just retries
      // on the next tick.
      if (/expired|not found/i.test(err.message)) stopLive(id);
    }
  }

  function startLive(id, kind) {
    const ui = uiFor(id);
    if (ui.watchTimer) return; // already running
    ui.live = true;
    ui.watchTimer = setInterval(() => fetchLiveTick(id, kind), LIVE_POLL_MS);
    fetchLiveTick(id, kind);
  }

  function stopLive(id) {
    const ui = uiFor(id);
    if (ui.watchTimer) clearInterval(ui.watchTimer);
    ui.watchTimer = null;
    ui.live = false;
  }

  function toggleLive(id, kind) {
    const ui = uiFor(id);
    if (ui.live) stopLive(id);
    else startLive(id, kind);
    render(kind);
  }

  function toggleExpanded(id, kind) {
    const ui = uiFor(id);
    ui.expanded = !ui.expanded;
    render(kind);
  }

  function refreshNow(id, kind) {
    fetchLiveTick(id, kind);
  }

  // ---------- phone actions (mirror email) ----------

  async function createPhone() {
    const ttlMinutes = Number(document.getElementById('phoneTtl').value) || 15;
    try {
      const item = await api('/api/phones', { method: 'POST', body: JSON.stringify({ ttlMinutes }) });
      toast('Number created', 'success');
      await refreshPhones();
      startLive(item.id, 'phones');
    } catch (err) {
      toast(`Create failed: ${err.message}`, 'error');
    }
  }

  async function extendPhone(id, minutes) {
    try {
      await api(`/api/phones/${id}/extend`, { method: 'PATCH', body: JSON.stringify({ minutes }) });
      toast(`Extended +${minutes}m`, 'success');
      await refreshPhones();
    } catch (err) {
      toast(`Extend failed: ${err.message}`, 'error');
    }
  }

  async function deletePhone(id) {
    const ui = uiFor(id);
    if (ui.watchTimer) clearInterval(ui.watchTimer);
    state.ui.delete(id);
    try {
      await api(`/api/phones/${id}`, { method: 'DELETE' });
      toast('Number deleted', 'success');
      await refreshPhones();
    } catch (err) {
      toast(`Delete failed: ${err.message}`, 'error');
    }
  }

  // ---------- rendering ----------

  function render(kind) {
    if (!kind || kind === 'emails') renderEmails();
    if (!kind || kind === 'phones') renderPhones();
  }

  function cardActionsHtml(id, kind, item) {
    const ui = uiFor(id);
    return `
      <div class="card-actions">
        <button class="small" data-action="toggle-live" data-kind="${kind}" data-id="${id}">
          ${ui.live ? '⏸ Pause' : '▶ Resume'}
        </button>
        <button class="small" data-action="refresh-now" data-kind="${kind}" data-id="${id}" title="Fetch right now">🔄 Now</button>
        <button class="small" data-action="toggle-expand" data-kind="${kind}" data-id="${id}">
          ${ui.expanded ? 'Hide messages' : 'Show messages'}
        </button>
        <button class="small" data-action="extend" data-kind="${kind}" data-id="${id}" data-minutes="15">+15m</button>
        <button class="small" data-action="extend" data-kind="${kind}" data-id="${id}" data-minutes="60">+60m</button>
        ${kind === 'emails' && !item.parentId ? `<button class="small" data-action="child" data-id="${id}">+ Child inbox</button>` : ''}
        <button class="small danger" data-action="delete" data-kind="${kind}" data-id="${id}">Delete</button>
      </div>
      ${ui.live && !ui.otp ? `<div class="live-indicator"><span class="live-dot"></span>Live — mail will appear here automatically</div>` : ''}
      ${ui.otp ? otpPanelHtml(ui.otp) : ''}
      ${ui.expanded ? messagesHtml(ui) : ''}
    `;
  }

  function otpPanelHtml(otp) {
    return `
      <div class="otp-panel">
        <div class="otp-code">${escapeHtml(otp.otp)}</div>
        <div class="muted">from ${escapeHtml(otp.from || 'unknown')} · ${otp.receivedAt ? new Date(otp.receivedAt).toLocaleTimeString() : ''}</div>
        <button class="small" data-action="copy-otp" data-value="${escapeHtml(otp.otp)}">Copy code</button>
      </div>
    `;
  }

  function messagesHtml(ui) {
    if (ui.loadingMessages) return `<div class="msg-list muted"><span class="spinner"></span>Loading…</div>`;
    if (!ui.messages || ui.messages.length === 0) return `<div class="msg-list muted">No messages yet.</div>`;
    return `<div class="msg-list">${ui.messages.map((m) => `
      <div class="msg">
        <div class="msg-top">
          <span>${escapeHtml(m.from || 'unknown')}</span>
          <span>${m.receivedAt ? new Date(m.receivedAt).toLocaleString() : ''}</span>
        </div>
        ${m.subject ? `<div><strong>${escapeHtml(m.subject)}</strong></div>` : ''}
        <div class="msg-body">${escapeHtml((m.text || '').slice(0, 500))}</div>
      </div>
    `).join('')}</div>`;
  }

  function emailCardHtml(item) {
    const remaining = fmtRemaining(item.expiresAt);
    return `
      <div class="card ${item.parentId ? 'child' : ''}" data-id="${item.id}">
        <div class="card-row">
          <span class="card-id">${escapeHtml(item.address)}</span>
          <span class="card-meta">
            <button class="small" data-action="copy" data-value="${escapeHtml(item.address)}">📋</button>
            <span class="ttl ${remaining.cls}">${remaining.text}</span>
          </span>
        </div>
        ${cardActionsHtml(item.id, 'emails', item)}
      </div>
    `;
  }

  function phoneCardHtml(item) {
    const remaining = fmtRemaining(item.expiresAt);
    return `
      <div class="card" data-id="${item.id}">
        <div class="card-row">
          <span class="card-id">${escapeHtml(item.number)}</span>
          <span class="card-meta">
            <button class="small" data-action="copy" data-value="${escapeHtml(item.number)}">📋</button>
            <span class="badge ${item.provider}">${item.provider}</span>
            <span class="ttl ${remaining.cls}">${remaining.text}</span>
          </span>
        </div>
        ${cardActionsHtml(item.id, 'phones', item)}
      </div>
    `;
  }

  function renderEmails() {
    const root = document.getElementById('emailList');
    if (state.emails.length === 0) {
      root.innerHTML = `<p class="empty muted">No inboxes yet — create one above.</p>`;
      return;
    }
    // parents first, then their children directly beneath them
    const parents = state.emails.filter((e) => !e.parentId);
    const orphanChildren = state.emails.filter((e) => e.parentId && !state.emails.some((p) => p.id === e.parentId));
    const ordered = [];
    for (const p of parents) {
      ordered.push(p);
      for (const c of state.emails.filter((e) => e.parentId === p.id)) ordered.push(c);
    }
    ordered.push(...orphanChildren);
    root.innerHTML = ordered.map(emailCardHtml).join('');
  }

  function renderPhones() {
    const root = document.getElementById('phoneList');
    if (state.phones.length === 0) {
      root.innerHTML = `<p class="empty muted">No numbers yet — create one above.</p>`;
      return;
    }
    root.innerHTML = state.phones.map(phoneCardHtml).join('');
  }

  // ---------- event delegation ----------

  function onListClick(kind, e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id, minutes, value } = btn.dataset;
    if (action === 'toggle-live') toggleLive(id, kind);
    else if (action === 'refresh-now') refreshNow(id, kind);
    else if (action === 'toggle-expand') toggleExpanded(id, kind);
    else if (action === 'extend') (kind === 'emails' ? extendEmail : extendPhone)(id, Number(minutes));
    else if (action === 'delete') (kind === 'emails' ? deleteEmail : deletePhone)(id);
    else if (action === 'child') createEmail(id);
    else if (action === 'copy') copyToClipboard(value, kind === 'emails' ? 'address' : 'number');
    else if (action === 'copy-otp') copyToClipboard(value, 'OTP');
  }

  function init() {
    document.getElementById('tabLogin').addEventListener('click', () => switchGateTab('login'));
    document.getElementById('tabSignup').addEventListener('click', () => switchGateTab('signup'));
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('signupForm').addEventListener('submit', handleSignup);
    document.getElementById('pasteKeyBtn').addEventListener('click', usePastedKey);
    document.getElementById('signOutBtn').addEventListener('click', handleLogout);
    document.getElementById('mfaManageBtn').addEventListener('click', toggleMfaPanel);
    document.getElementById('toggleKeyBtn').addEventListener('click', () => {
      const el = document.getElementById('apiKeyDisplay');
      setKeyMasked(el.textContent.startsWith('•') === false);
    });
    document.getElementById('copyKeyBtn').addEventListener('click', () => copyToClipboard(state.account.apiKey, 'API key'));
    document.getElementById('createEmailBtn').addEventListener('click', () => createEmail());
    document.getElementById('createPhoneBtn').addEventListener('click', createPhone);
    document.getElementById('emailList').addEventListener('click', (e) => onListClick('emails', e));
    document.getElementById('phoneList').addEventListener('click', (e) => onListClick('phones', e));
    document.getElementById('refreshEmailsBtn').addEventListener('click', async () => {
      await refreshEmails();
      toast('Inbox list refreshed', 'success');
    });
    document.getElementById('refreshPhonesBtn').addEventListener('click', async () => {
      await refreshPhones();
      toast('Number list refreshed', 'success');
    });

    // live countdowns without a full re-render
    setInterval(() => {
      document.querySelectorAll('.card').forEach((card) => {
        const id = card.dataset.id;
        const item = state.emails.find((x) => x.id === id) || state.phones.find((x) => x.id === id);
        if (!item) return;
        const span = card.querySelector('.ttl');
        if (!span) return;
        const remaining = fmtRemaining(item.expiresAt);
        span.textContent = remaining.text;
        span.className = `ttl ${remaining.cls}`;
      });
    }, 1000);

    // periodic full refresh to catch changes / newly expired items
    setInterval(refreshAll, 20000);

    tryRestoreSession();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
