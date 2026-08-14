const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'tempmail.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    api_key TEXT UNIQUE NOT NULL,
    label TEXT,
    email TEXT UNIQUE,
    password_hash TEXT,
    mfa_secret TEXT,
    mfa_enabled INTEGER NOT NULL DEFAULT 0,
    mfa_backup_codes TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mailboxes (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    parent_id TEXT,
    address TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_password TEXT,
    provider_token TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (parent_id) REFERENCES mailboxes(id)
  );

  CREATE TABLE IF NOT EXISTS phone_numbers (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_sid TEXT,
    number TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );
`);

// Idempotent migration for databases created before real accounts/MFA
// existed — CREATE TABLE IF NOT EXISTS above only helps fresh DBs.
const existingColumns = new Set(db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name));
const migrations = {
  email: 'ALTER TABLE accounts ADD COLUMN email TEXT',
  password_hash: 'ALTER TABLE accounts ADD COLUMN password_hash TEXT',
  mfa_secret: 'ALTER TABLE accounts ADD COLUMN mfa_secret TEXT',
  mfa_enabled: 'ALTER TABLE accounts ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0',
  mfa_backup_codes: 'ALTER TABLE accounts ADD COLUMN mfa_backup_codes TEXT',
};
for (const [column, sql] of Object.entries(migrations)) {
  if (!existingColumns.has(column)) db.exec(sql);
}
// email needs to be unique, but ALTER TABLE can't add that constraint
// after the fact — enforce it via a unique index instead.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email) WHERE email IS NOT NULL');

module.exports = db;
