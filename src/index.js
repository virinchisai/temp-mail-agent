require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const registerRoute = require('./routes/register');
const authRoute = require('./routes/auth');
const emailsRoute = require('./routes/emails');
const phonesRoute = require('./routes/phones');
const agentRoute = require('./routes/agent');
const { startExpirySweeper } = require('./jobs/expiry');

const app = express();
const PORT = process.env.PORT || 4000;
const isProd = process.env.NODE_ENV === 'production';

// Behind a hosting platform's reverse proxy (Fly.io, Render, etc.) — needed
// so rate limiting and the HTTPS redirect see the real client IP/protocol
// instead of the proxy's.
if (isProd) app.set('trust proxy', 1);

// Platform TLS termination forwards X-Forwarded-Proto; bounce plain HTTP
// to HTTPS so session cookies (marked `secure`) actually get sent.
if (isProd) {
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') === 'http') {
      return res.redirect(301, `https://${req.header('host')}${req.url}`);
    }
    next();
  });
}

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(morgan('dev'));

// The agent reaches its own REST API over loopback, so without this every
// agent run — regardless of which account triggered it — would share the
// 127.0.0.1 bucket and exhaust it almost immediately. Safe to skip: in
// production `trust proxy` means real clients present their forwarded IP,
// so only genuine same-host calls land here. Each request is still
// authenticated and scoped to one account's data.
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip);

// Baseline limiter for everything.
app.use(
  rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_PER_MINUTE) || 60,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isLoopback,
  })
);

// Tighter limiter specifically on auth endpoints — these are the ones
// worth brute-forcing (passwords, MFA codes) or abusing for mass account
// creation, so they get a much lower ceiling than general API traffic.
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: Number(process.env.AUTH_RATE_LIMIT_PER_15MIN) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again later' },
});
app.use('/api/register', authLimiter);
app.use('/api/auth', authLimiter);

// Tighter limiter on resource creation, mainly relevant once PUBLIC_SIGNUP
// is on and any account could otherwise mint inboxes/numbers as fast as
// the network allows.
const creationLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: Number(process.env.CREATION_RATE_LIMIT_PER_HOUR) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Creation rate limit reached — try again later' },
});

// Each agent turn is one or more LLM calls plus a burst of tool calls, so
// it is far more expensive than a plain API request and gets its own,
// much lower ceiling.
const agentLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.AGENT_RATE_LIMIT_PER_MINUTE) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Agent rate limit reached — try again in a minute' },
});
app.use('/api/agent/chat', agentLimiter);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

app.use('/api', registerRoute);
app.use('/api', authRoute);
app.post('/api/emails', creationLimiter);
app.post('/api/phones', creationLimiter);
app.use('/api/emails', emailsRoute);
app.use('/api/phones', phonesRoute);
app.use('/api', agentRoute);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`temp-mail-agent listening on http://localhost:${PORT}${isProd ? ' (production)' : ''}`);
  startExpirySweeper();
});
