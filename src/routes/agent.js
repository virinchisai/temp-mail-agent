const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { runAgent, MissingApiKeyError, MODEL, isConfigured, isLocal } = require('../agent/agent');

const router = express.Router();
router.use(requireAuth);

const MAX_HISTORY = 40; // messages, not turns — keeps a long chat from growing unbounded

// Lets the dashboard hide or disable the chat panel when the deployment
// has no ANTHROPIC_API_KEY, instead of only finding out on first send.
router.get('/agent/status', (req, res) => {
  res.json({ enabled: isConfigured(), model: MODEL, local: isLocal() });
});

router.post('/agent/chat', async (req, res) => {
  const { message, history } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (history !== undefined && !Array.isArray(history)) {
    return res.status(400).json({ error: 'history must be an array' });
  }

  const messages = [...(history || []).slice(-MAX_HISTORY), { role: 'user', content: message }];

  // The agent calls this same service over HTTP as the authenticated
  // account, so it can only reach that account's own inboxes.
  const port = process.env.PORT || 4000;
  const baseUrl = process.env.SELF_BASE_URL || `http://127.0.0.1:${port}`;

  try {
    const { reply, steps, messages: updated } = await runAgent({
      apiKey: req.account.api_key,
      baseUrl,
      messages,
    });
    res.json({ reply, steps, history: updated });
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return res.status(503).json({ error: err.message });
    }
    console.error('[agent] run failed:', err);
    res.status(502).json({ error: 'The agent failed to complete', detail: err.message });
  }
});

module.exports = router;
