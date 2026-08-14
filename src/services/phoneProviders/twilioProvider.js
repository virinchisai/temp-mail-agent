// Real SMS-receiving numbers via Twilio. Requires your own Twilio account
// (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in .env) — numbers are rented
// from Twilio and billed to that account, so this stays tied to a real,
// registered, KYC'd provider rather than an anonymous public pool.
let twilioClient = null;

function getClient() {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — see .env.example');
  }
  const twilio = require('twilio');
  twilioClient = twilio(sid, token);
  return twilioClient;
}

async function provisionNumber() {
  const client = getClient();
  const available = await client.availablePhoneNumbers('US').local.list({ smsEnabled: true, limit: 1 });
  if (!available.length) throw new Error('No available Twilio numbers found');
  const purchased = await client.incomingPhoneNumbers.create({ phoneNumber: available[0].phoneNumber });
  return { number: purchased.phoneNumber, providerSid: purchased.sid };
}

async function listMessages(phoneRow) {
  const client = getClient();
  const messages = await client.messages.list({ to: phoneRow.number, limit: 20 });
  return messages.map((m) => ({
    id: m.sid,
    from: m.from,
    text: m.body,
    receivedAt: m.dateSent || m.dateCreated,
  }));
}

async function releaseNumber(phoneRow) {
  const client = getClient();
  if (!phoneRow.provider_sid) return;
  await client.incomingPhoneNumbers(phoneRow.provider_sid).remove();
}

module.exports = { name: 'twilio', provisionNumber, listMessages, releaseNumber };
