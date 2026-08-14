const db = require('../db');
const { SESSION_COOKIE, verifySessionToken } = require('../utils/authSecurity');

// Accepts either an x-api-key header (programmatic/API clients — what you
// hand to another application) or a session cookie (the dashboard, after
// email+password+MFA login). Either is sufficient.
function requireAuth(req, res, next) {
  const apiKey = req.header('x-api-key');
  if (apiKey) {
    const account = db.prepare('SELECT * FROM accounts WHERE api_key = ?').get(apiKey);
    if (!account) return res.status(401).json({ error: 'Invalid API key' });
    req.account = account;
    req.authMethod = 'api-key';
    return next();
  }

  const sessionToken = req.cookies?.[SESSION_COOKIE];
  if (sessionToken) {
    const accountId = verifySessionToken(sessionToken);
    if (accountId) {
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
      if (account) {
        req.account = account;
        req.authMethod = 'session';
        return next();
      }
    }
  }

  return res.status(401).json({ error: 'Missing or invalid credentials (x-api-key header or session)' });
}

module.exports = { requireAuth };
