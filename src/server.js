import { appendFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as api from './api.js';
import { Auth, cookieToken } from './auth.js';
import { MetricsCollector } from './metrics.js';
import { Board, connect } from './ssh.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.CONSOLE_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CONSOLE_PORT ?? 8088);
const DATA_DIR = process.env.CONSOLE_DATA_DIR ?? join(ROOT, 'data');
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', HOST, ...(process.env.CONSOLE_ALLOWED_HOSTS ?? '').split(',').filter(Boolean)]);
const MAX_JSON_BODY = 16 * 1024;
const MAX_TERMINALS = 8;

const auth = new Auth(DATA_DIR);

if (process.argv.includes('--reset-password')) {
  console.log(`New password: ${auth.resetPassword()}`);
  process.exit(0);
}

const HOSTS_FILE = join(ROOT, 'config', 'hosts.json');
if (!existsSync(HOSTS_FILE)) {
  console.error('Missing config/hosts.json. Copy config/hosts.example.json to config/hosts.json and edit it for your boards.');
  process.exit(1);
}
const hosts = JSON.parse(readFileSync(HOSTS_FILE, 'utf8'))
  .map((h) => ({ port: 22, ...h }));
const boards = new Map(hosts.map((h) => {
  const board = new Board(h);
  return [h.id, { config: h, board, metrics: new MetricsCollector(board) }];
}));

const STATIC = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/views.js', ['public/views.js', 'text/javascript; charset=utf-8']],
  ['/charts.js', ['public/charts.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/vendor/xterm.mjs', ['node_modules/@xterm/xterm/lib/xterm.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/xterm.css', ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8']],
  ['/vendor/addon-fit.mjs', ['node_modules/@xterm/addon-fit/lib/addon-fit.mjs', 'text/javascript; charset=utf-8']],
]);

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function audit(req, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ip: req.socket.remoteAddress, ...entry });
  appendFile(join(DATA_DIR, 'audit.log'), `${line}\n`).catch((err) => console.error('audit log:', err.message));
}

function hostAllowed(req) {
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  return ALLOWED_HOSTNAMES.has(hostname);
}

/** Blocks cross-site requests: the Origin must be this server's own address. */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY) throw new api.HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new api.HttpError(400, 'Invalid JSON');
  }
}

async function handleHostRoute(req, res, url, entry, parts) {
  const { board, config, metrics } = entry;
  const { method } = req;
  const route = `${method} ${parts[0]}`;
  const q = url.searchParams;
  const logged = async (action, target, run) => {
    try {
      const result = await run();
      audit(req, { host: config.id, action, target, ok: true });
      return result;
    } catch (err) {
      audit(req, { host: config.id, action, target, ok: false, error: err.message });
      throw err;
    }
  };

  switch (route) {
    case 'GET metrics':
      try {
        return sendJson(res, 200, await metrics.get());
      } catch (err) {
        metrics.invalidate();
        return sendJson(res, 200, { online: false, error: err.message, history: metrics.history });
      }
    case 'GET services':
      return sendJson(res, 200, await api.services(board));
    case 'POST services': {
      const [, unit, action] = parts;
      return sendJson(res, 200, await logged(`service.${action}`, unit, () => api.serviceAction(board, unit, action)));
    }
    case 'GET processes':
      return sendJson(res, 200, await api.processes(board));
    case 'POST processes': {
      const { signal } = await readJson(req);
      return sendJson(res, 200, await logged(`signal.${signal}`, parts[1], () => api.signalProcess(board, parts[1], signal)));
    }
    case 'GET containers':
      if (parts[2] === 'logs') return sendJson(res, 200, await api.containerLogs(board, parts[1], q.get('lines')));
      return sendJson(res, 200, await api.containers(board));
    case 'POST containers': {
      const [, id, action] = parts;
      return sendJson(res, 200, await logged(`container.${action}`, id, () => api.containerAction(board, id, action)));
    }
    case 'GET journal':
      return sendJson(res, 200, await api.journal(board, { unit: q.get('unit'), lines: q.get('lines'), priority: q.get('priority') }));
    case 'GET updates':
      return sendJson(res, 200, await api.updates(board));
    case 'POST power': {
      const { action, confirm } = await readJson(req);
      return sendJson(res, 200, await logged(`power.${action}`, config.id, () => api.power(board, config, action, confirm)));
    }
    case 'GET files':
      if (parts[1] === 'download') {
        audit(req, { host: config.id, action: 'file.download', target: q.get('path') });
        return api.downloadFile(board, q.get('path'), res);
      }
      return sendJson(res, 200, await api.listFiles(board, q.get('path') ?? '/'));
    case 'POST files':
      return sendJson(res, 200, await logged('file.upload', q.get('path'), () => api.uploadFile(board, q.get('path'), req)));
    default:
      throw new api.HttpError(404, 'Not found');
  }
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
  const token = cookieToken(req);

  if (req.method !== 'GET' && !originAllowed(req)) {
    throw new api.HttpError(403, 'Cross-origin request refused');
  }

  if (parts[0] === 'login' && req.method === 'POST') {
    const { password } = await readJson(req);
    let session;
    try {
      session = auth.login(password, req.socket.remoteAddress);
    } catch (err) {
      throw new api.HttpError(429, err.message);
    }
    audit(req, { action: 'login', ok: Boolean(session) });
    if (!session) throw new api.HttpError(401, 'Wrong password');
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': `session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    });
  }

  if (!auth.valid(token)) throw new api.HttpError(401, 'Not signed in');

  if (parts[0] === 'logout' && req.method === 'POST') {
    auth.logout(token);
    audit(req, { action: 'logout', ok: true });
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (parts[0] === 'hosts' && parts.length === 1 && req.method === 'GET') {
    return sendJson(res, 200, hosts.map(({ id, name, host, user }) => ({ id, name, host, user })));
  }
  if (parts[0] === 'hosts' && parts.length >= 3) {
    const entry = boards.get(parts[1]);
    if (!entry) throw new api.HttpError(404, 'Unknown board');
    return handleHostRoute(req, res, url, entry, parts.slice(2));
  }
  throw new api.HttpError(404, 'Not found');
}

async function handleStatic(req, res, url) {
  const file = STATIC.get(url.pathname);
  if (!file || req.method !== 'GET') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const body = await readFile(join(ROOT, file[0]));
  res.writeHead(200, { 'Content-Type': file[1] });
  res.end(body);
}

const server = createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (!hostAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Host not allowed');
    return;
  }
  const url = new URL(req.url, 'http://console.invalid');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await handleStatic(req, res, url);
  } catch (err) {
    const status = err instanceof api.HttpError ? err.status : 502;
    if (res.headersSent) {
      res.destroy();
    } else {
      sendJson(res, status, { error: err.message });
    }
  }
});

// Terminals get their own SSH connection each, so a busy shell cannot starve metrics.
const terminals = new Map();
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function openTerminal(ws, req, entry, cols, rows) {
  const token = cookieToken(req);
  const pending = [];
  let shell = null;
  let conn = null;
  const session = { ws, token };
  terminals.set(ws, session);

  const close = () => {
    terminals.delete(ws);
    shell?.close();
    conn?.end();
    if (ws.readyState === ws.OPEN) ws.close();
  };

  ws.on('close', close);
  ws.on('error', close);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'resize' && shell) shell.setWindow(clampSize(msg.rows, 24), clampSize(msg.cols, 80), 0, 0);
      } catch { /* ignore malformed control frames */ }
      return;
    }
    if (shell) shell.write(data);
    else pending.push(data);
  });

  audit(req, { host: entry.config.id, action: 'terminal.open' });
  connect(entry.config).then((c) => {
    conn = c;
    if (!terminals.has(ws)) {
      c.end();
      return;
    }
    c.on('error', close);
    c.on('close', close);
    c.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) {
        ws.send(`\r\nCould not open a shell: ${err.message}\r\n`);
        close();
        return;
      }
      shell = stream;
      pending.splice(0).forEach((d) => stream.write(d));
      stream.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: true }); });
      stream.stderr.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: true }); });
      stream.on('close', close);
    });
  }).catch((err) => {
    if (ws.readyState === ws.OPEN) ws.send(`\r\nConnection failed: ${err.message}\r\n`);
    close();
  });
}

const clampSize = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.min(500, Math.max(2, n));
};

auth.onSessionEnd = (token) => {
  for (const session of [...terminals.values()]) {
    if (session.token === token) session.ws.close();
  }
};

server.on('upgrade', (req, socket, head) => {
  const refuse = (status) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  const url = new URL(req.url, 'http://console.invalid');
  const entry = boards.get(url.searchParams.get('host'));
  if (url.pathname !== '/ws/terminal' || !entry) return refuse('404 Not Found');
  if (!hostAllowed(req) || !originAllowed(req)) return refuse('403 Forbidden');
  if (!auth.valid(cookieToken(req))) return refuse('401 Unauthorized');
  if (terminals.size >= MAX_TERMINALS) return refuse('429 Too Many Requests');
  wss.handleUpgrade(req, socket, head, (ws) => {
    openTerminal(ws, req, entry, clampSize(url.searchParams.get('cols'), 80), clampSize(url.searchParams.get('rows'), 24));
  });
  return undefined;
});

const firstPassword = auth.ensurePassword();
server.listen(PORT, HOST, () => {
  console.log(`Board Console: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (firstPassword) console.log(`First-run password (shown once): ${firstPassword}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn('Warning: listening beyond this PC over plain HTTP. Anyone on the network can sniff your session. Put it behind TLS or a VPN.');
  }
});
