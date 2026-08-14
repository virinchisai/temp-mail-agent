const crypto = require('crypto');

function generateApiKey() {
  return 'tma_' + crypto.randomBytes(24).toString('hex');
}

function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

function randomLocalPart() {
  return 'inbox' + crypto.randomBytes(5).toString('hex');
}

module.exports = { generateApiKey, generatePassword, randomLocalPart };
