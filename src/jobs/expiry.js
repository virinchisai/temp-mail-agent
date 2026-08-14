const cron = require('node-cron');
const db = require('../db');
const mailProvider = require('../services/mailProvider');
const { resolveProvider } = require('../services/phoneProviders');

async function sweepExpiredMailboxes() {
  const expired = db.prepare('SELECT * FROM mailboxes WHERE expires_at < ?').all(Date.now());
  for (const mailbox of expired) {
    await mailProvider.deleteMailbox(mailbox);
    db.prepare('DELETE FROM mailboxes WHERE id = ?').run(mailbox.id);
    console.log(`[expiry] removed mailbox ${mailbox.address}`);
  }
}

async function sweepExpiredPhones() {
  const expired = db.prepare('SELECT * FROM phone_numbers WHERE expires_at < ?').all(Date.now());
  for (const phone of expired) {
    try {
      const provider = resolveProvider(phone.provider);
      await provider.releaseNumber(phone);
    } catch (err) {
      console.warn(`[expiry] release failed for ${phone.number}: ${err.message}`);
    }
    db.prepare('DELETE FROM phone_numbers WHERE id = ?').run(phone.id);
    console.log(`[expiry] removed phone ${phone.number}`);
  }
}

function startExpirySweeper() {
  // Runs every minute; cheap no-op when nothing has expired.
  cron.schedule('* * * * *', async () => {
    try {
      await sweepExpiredMailboxes();
      await sweepExpiredPhones();
    } catch (err) {
      console.error('[expiry] sweep failed:', err);
    }
  });
}

module.exports = { startExpirySweeper };
