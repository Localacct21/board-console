import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;

function hash(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

export class Auth {
  constructor(dataDir) {
    this.file = join(dataDir, 'auth.json');
    this.sessions = new Map();
    this.failures = new Map();
    this.onSessionEnd = () => {};
    mkdirSync(dataDir, { recursive: true });
    setInterval(() => this.sweep(), 60000).unref();
  }

  /** Create a password on first run. Returns the plaintext only when one was generated. */
  ensurePassword() {
    return existsSync(this.file) ? null : this.resetPassword();
  }

  resetPassword() {
    const password = randomBytes(15).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    writeFileSync(this.file, JSON.stringify({ salt, hash: hash(password, salt) }), { mode: 0o600 });
    return password;
  }

  /** Returns a session token, null for a wrong password, or throws when locked out. */
  login(password, ip) {
    const record = this.failures.get(ip);
    if (record && record.count >= MAX_FAILURES && Date.now() - record.at < LOCKOUT_MS) {
      throw new Error('Too many attempts. Wait a minute and try again.');
    }
    const stored = JSON.parse(readFileSync(this.file, 'utf8'));
    const actual = Buffer.from(hash(String(password ?? ''), stored.salt), 'hex');
    if (!timingSafeEqual(actual, Buffer.from(stored.hash, 'hex'))) {
      const count = record && Date.now() - record.at < LOCKOUT_MS ? record.count + 1 : 1;
      this.failures.set(ip, { count, at: Date.now() });
      return null;
    }
    this.failures.delete(ip);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  valid(token) {
    const expires = token && this.sessions.get(token);
    return Boolean(expires && expires > Date.now());
  }

  logout(token) {
    if (this.sessions.delete(token)) this.onSessionEnd(token);
  }

  sweep() {
    for (const [token, expires] of this.sessions) {
      if (expires <= Date.now()) this.logout(token);
    }
  }
}

export function cookieToken(req) {
  const match = (req.headers.cookie ?? '').match(/(?:^|;\s*)session=([\w-]+)/);
  return match?.[1] ?? null;
}
