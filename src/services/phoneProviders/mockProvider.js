// Non-functional stand-in so the rest of the API (auth, expiry, extend,
// child grouping) can be exercised end-to-end without a real telecom
// account. Returns a fake number and a canned message — never real SMS.
const crypto = require('crypto');

async function provisionNumber() {
  const number = '+1555' + crypto.randomInt(1000000, 9999999).toString().slice(0, 7);
  return { number, providerSid: 'mock_' + crypto.randomBytes(6).toString('hex') };
}

async function listMessages(/* phoneRow */) {
  return [
    {
      id: 'mock-message-1',
      from: '+15555550100',
      text: 'This is a mock provider. Your code is 123456. Configure a real SMS provider (see README) to receive live SMS.',
      receivedAt: new Date().toISOString(),
    },
  ];
}

async function releaseNumber(/* phoneRow */) {
  // nothing to release
}

module.exports = { name: 'mock', provisionNumber, listMessages, releaseNumber };
