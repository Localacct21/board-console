import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'ssh2';

const MAX_CONCURRENT_EXECS = 5;
const KNOWN_HOSTS = join(homedir(), '.ssh', 'known_hosts');

const expandHome = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

/** Base64 host keys pinned for a host in the user's known_hosts file. */
function pinnedKeys(host, port) {
  const name = port === 22 ? host : `[${host}]:${port}`;
  let text;
  try {
    text = readFileSync(KNOWN_HOSTS, 'utf8');
  } catch {
    return new Set();
  }
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;
    const [names, , key] = line.split(/\s+/);
    if (key && names.split(',').includes(name)) keys.add(key);
  }
  return keys;
}

/** Open an authenticated connection; rejects on unknown or changed host keys. */
export function connect(host) {
  return new Promise((resolve, reject) => {
    const pins = pinnedKeys(host.host, host.port);
    if (pins.size === 0) {
      reject(new Error(`${host.host} is not in known_hosts. Run "ssh ${host.user}@${host.host}" once to trust it.`));
      return;
    }
    let privateKey;
    try {
      privateKey = readFileSync(expandHome(host.key));
    } catch (err) {
      reject(new Error(`Cannot read SSH key ${host.key}: ${err.code}`));
      return;
    }
    const conn = new Client();
    let hostKeyRejected = false;
    conn.once('ready', () => resolve(conn));
    conn.once('error', (err) => {
      reject(hostKeyRejected
        ? new Error(`Host key for ${host.host} does not match known_hosts. Refusing to connect.`)
        : err);
    });
    conn.connect({
      host: host.host,
      port: host.port,
      username: host.user,
      privateKey,
      forceIPv4: true,
      readyTimeout: 8000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key) => {
        const ok = pins.has(Buffer.from(key).toString('base64'));
        if (!ok) hostKeyRejected = true;
        return ok;
      },
    });
  });
}

/** One shared connection per board for short commands and SFTP. */
export class Board {
  constructor(config) {
    this.config = config;
    this.conn = null;
    this.connecting = null;
    this.active = 0;
    this.waiting = [];
  }

  connection() {
    if (this.conn) return Promise.resolve(this.conn);
    if (!this.connecting) {
      this.connecting = connect(this.config)
        .then((conn) => {
          this.conn = conn;
          const drop = () => { if (this.conn === conn) this.conn = null; };
          conn.on('close', drop);
          conn.on('end', drop);
          conn.on('error', drop);
          return conn;
        })
        .finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async slot() {
    if (this.active >= MAX_CONCURRENT_EXECS) {
      await new Promise((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
  }

  release() {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  /** Run a command. Resolves with { stdout, stderr, code } and never throws on non-zero exit. */
  async run(command, { timeout = 15000 } = {}) {
    await this.slot();
    try {
      const conn = await this.connection();
      return await new Promise((resolve, reject) => {
        conn.exec(command, (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          let stdout = '';
          let stderr = '';
          const timer = setTimeout(() => {
            stream.close();
            reject(new Error(`Command timed out after ${timeout / 1000}s`));
          }, timeout);
          stream.on('data', (d) => { stdout += d; });
          stream.stderr.on('data', (d) => { stderr += d; });
          stream.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code: code ?? 0 });
          });
        });
      });
    } finally {
      this.release();
    }
  }

  /** Open a command channel for streaming. Not counted against the exec limit because transfers can be long. */
  async stream(command) {
    const conn = await this.connection();
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => (err ? reject(err) : resolve(stream)));
    });
  }
}

/** Quote a value for a POSIX shell. */
export const shq = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
