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

// Baseline limiter for everything.
app.use(
  rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_PER_MINUTE) || 60,
    standardHeaders: true,
    legacyHeaders: false,
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

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

app.use('/api', registerRoute);
app.use('/api', authRoute);
app.post('/api/emails', creationLimiter);
app.post('/api/phones', creationLimiter);
app.use('/api/emails', emailsRoute);
app.use('/api/phones', phonesRoute);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`temp-mail-agent listening on http://localhost:${PORT}${isProd ? ' (production)' : ''}`);
  startExpirySweeper();
});
