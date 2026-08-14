/**
 * Drop-in helper for the app that OWNS the page you include this on.
 * It polls your temp-mail-agent API for an OTP and fills a field on
 * THIS page — it does not reach into other sites or other tabs.
 *
 * Usage:
 *   <script src="http://localhost:4000/autofill.js"></script>
 *   <script>
 *     TempMailAutofill.pollAndFill({
 *       apiBase: 'http://localhost:4000',
 *       apiKey: 'tma_xxx',
 *       mailboxId: 'xxxx',   // or phoneId: 'xxxx'
 *       inputSelector: '#otp-input',
 *     }).then(otp => console.log('filled', otp));
 */
(function (global) {
  async function pollAndFill({
    apiBase,
    apiKey,
    mailboxId,
    phoneId,
    inputSelector,
    intervalMs = 3000,
    timeoutMs = 120000,
  }) {
    if (!apiKey) throw new Error('apiKey is required');
    if (!mailboxId && !phoneId) throw new Error('mailboxId or phoneId is required');

    const endpoint = mailboxId
      ? `${apiBase}/api/emails/${mailboxId}/otp`
      : `${apiBase}/api/phones/${phoneId}/otp`;

    const start = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error('Timed out waiting for OTP'));
          return;
        }
        try {
          const res = await fetch(endpoint, { headers: { 'x-api-key': apiKey } });
          if (!res.ok) return; // keep polling on transient errors
          const data = await res.json();
          if (data.otp) {
            clearInterval(timer);
            if (inputSelector) {
              const el = document.querySelector(inputSelector);
              if (el) {
                el.value = data.otp;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
            resolve(data.otp);
          }
        } catch {
          // network hiccup — keep polling
        }
      }, intervalMs);
    });
  }

  global.TempMailAutofill = { pollAndFill };
})(window);
