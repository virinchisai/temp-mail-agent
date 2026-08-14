const mock = require('./mockProvider');
const twilio = require('./twilioProvider');

const providers = { mock, twilio };

function hasTwilioCreds() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

// PUBLIC_SIGNUP=true means anyone on the internet can create an account —
// real phone numbers would then be provisioned (and billed to whoever owns
// the Twilio account) for anonymous strangers. Hard-block that regardless
// of what credentials happen to be configured; a public deployment only
// ever gets the mock provider unless this is explicitly overridden.
const PUBLIC_SIGNUP = process.env.PUBLIC_SIGNUP === 'true';

// Defaults to the mock provider unless real Twilio credentials are present,
// so `npm start` works out of the box without silently pretending to send
// real SMS numbers.
function resolveProvider(requested) {
  const name = PUBLIC_SIGNUP ? 'mock' : requested || (hasTwilioCreds() ? 'twilio' : 'mock');
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown phone provider "${name}"`);
  return provider;
}

function effectivePhoneProvider() {
  return PUBLIC_SIGNUP ? 'mock' : hasTwilioCreds() ? 'twilio' : 'mock';
}

module.exports = { resolveProvider, providers, hasTwilioCreds, effectivePhoneProvider, PUBLIC_SIGNUP };
