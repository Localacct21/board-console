import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import * as views from './views.js';

const POLL_MS = 3000;
const HOST_TABS = [
  ['overview', 'Overview'],
  ['services', 'Services'],
  ['docker', 'Docker'],
  ['processes', 'Processes'],
  ['logs', 'Logs'],
  ['files', 'Files'],
  ['updates', 'Updates'],
];

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

export function toast(message, bad = false) {
  const el = h('div', { class: `toast${bad ? ' bad' : ''}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), bad ? 8000 : 4000);
}

export async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, {
    method: options.method ?? 'GET',
    headers: options.json ? { 'Content-Type': 'application/json' } : undefined,
    body: options.json ? JSON.stringify(options.json) : options.body,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') {
    showLogin();
    throw new Error('Signed out');
  }
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export function confirmDialog({ title, body, confirmLabel, typed = null }) {
  return new Promise((resolve) => {
    const input = typed ? h('input', { 'aria-label': `Type ${typed} to confirm`, autocomplete: 'off' }) : null;
    const okButton = h('button', { class: 'danger-solid', type: 'submit', disabled: Boolean(typed) }, confirmLabel);
    const dialog = h('dialog', {},
      h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          dialog.close('ok');
        },
      },
      h('h2', {}, title),
      h('p', {}, body),
      typed && h('p', {}, 'Type ', h('code', {}, typed), ' to confirm.'),
      input,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', onclick: () => dialog.close('cancel') }, 'Cancel'),
        okButton)));
    input?.addEventListener('input', () => { okButton.disabled = input.value !== typed; });
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok');
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

export const state = {
  hosts: [],
  metrics: new Map(),
};

let currentView = null;
let pollTimer = null;
let shellEls = null;

/* Terminals live outside the router so sessions survive page changes. */
const terminals = [];
let termId = 0;
const consoleRoot = () => shellEls.console;

export function openTerminal(hostId, typedText = '') {
  // xterm has to open inside the live DOM to measure its cells.
  if (!shellEls.console.isConnected) {
    shellEls.opened = true;
    location.hash = '#/console';
    renderRoute();
  }
  shellEls.empty.hidden = true;
  const host = state.hosts.find((x) => x.id === hostId);
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: { background: '#111110', foreground: '#e6e5e0' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const statusEl = h('span', { class: 'term-state' }, 'connecting');
  const body = h('div', { class: 'term-body' });
  const session = { id: ++termId, hostId, term, fit, ws: null };
  const reconnect = h('button', { hidden: true, onclick: () => connectSession(session) }, 'Reconnect');
  const pane = h('section', { class: 'term-pane', 'aria-label': `${host.name} terminal` },
    h('div', { class: 'term-head' },
      h('span', {}, h('strong', {}, host.name), ' ', h('span', { class: 'mono' }, `${host.user}@${host.host}`), ' · ', statusEl),
      h('span', { class: 'row' }, reconnect, h('button', { 'aria-label': `Close ${host.name} terminal`, onclick: () => closeTerminal(session) }, 'Close'))),
    body);
  Object.assign(session, { pane, statusEl, reconnect, typedText });
  terminals.push(session);
  shellEls.grid.append(pane);
  term.open(body);
  term.onData((data) => {
    if (session.ws?.readyState === WebSocket.OPEN) session.ws.send(new TextEncoder().encode(data));
  });
  term.onResize(({ cols, rows }) => {
    if (session.ws?.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
  session.observer = new ResizeObserver(() => {
    if (body.clientWidth > 0) fit.fit();
  });
  session.observer.observe(body);
  fit.fit();
  connectSession(session);
  term.focus();
  return session;
}

function connectSession(session) {
  const { term, hostId } = session;
  session.reconnect.hidden = true;
  session.statusEl.textContent = 'connecting';
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws/terminal?host=${encodeURIComponent(hostId)}&cols=${term.cols}&rows=${term.rows}`);
  ws.binaryType = 'arraybuffer';
  session.ws = ws;
  ws.addEventListener('open', () => {
    session.statusEl.textContent = 'connected';
    if (session.typedText) {
      // Typed but not sent, so you press Enter yourself.
      ws.send(new TextEncoder().encode(session.typedText));
      session.typedText = '';
    }
  });
  ws.addEventListener('message', (event) => {
    term.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));
  });
  ws.addEventListener('close', () => {
    if (session.ws !== ws) return;
    session.statusEl.textContent = 'disconnected';
    session.reconnect.hidden = false;
    term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
  });
}

function closeTerminal(session) {
  const ws = session.ws;
  session.ws = null;
  ws?.close();
  session.observer.disconnect();
  session.term.dispose();
  session.pane.remove();
  terminals.splice(terminals.indexOf(session), 1);
  shellEls.empty.hidden = terminals.length > 0;
}

function closeAllTerminals() {
  [...terminals].forEach(closeTerminal);
}

function buildConsole() {
  const grid = h('div', { class: 'console-grid' });
  const empty = h('p', { class: 'muted', hidden: true }, 'No terminals open. Open one above.');
  const root = h('div', { class: 'console-root', hidden: true },
    h('div', { class: 'console-bar' },
      h('h1', {}, 'Console'),
      state.hosts.map((host) => h('button', {
        onclick: () => {
          openTerminal(host.id);
          empty.hidden = true;
        },
      }, `New ${host.name} shell`))),
    empty,
    grid);
  return { root, grid, empty };
}

function hashRoute() {
  const [first, tab] = location.hash.replace(/^#\/?/, '').split('/');
  if (first === 'console') return { page: 'console' };
  if (state.hosts.some((x) => x.id === first)) {
    const known = HOST_TABS.some(([key]) => key === tab);
    return { page: 'host', hostId: first, tab: known ? tab : 'overview' };
  }
  return { page: 'fleet' };
}

function renderSidebar() {
  const route = hashRoute();
  const item = (href, label, active) => h('a', { class: `nav-item${active ? ' active' : ''}`, href, 'aria-current': active ? 'page' : null }, label);
  shellEls.nav.replaceChildren(
    item('#/', 'All boards', route.page === 'fleet'),
    item('#/console', 'Console', route.page === 'console'),
    h('div', { class: 'nav-label' }, 'Boards'),
    ...state.hosts.map((host) => {
      const m = state.metrics.get(host.id);
      const stats = m?.online
        ? `CPU ${Math.round(m.cpu.percent)}%${m.temp === null ? '' : ` · ${Math.round(m.temp)}°C`}`
        : (m ? 'Offline' : 'Connecting');
      return item(`#/${host.id}`, [
        h('div', { class: 'nav-host-name' }, host.name),
        h('div', { class: 'nav-host-stats' }, stats),
      ], route.hostId === host.id);
    }),
  );
}

function renderRoute() {
  currentView?.destroy?.();
  currentView = null;
  const route = hashRoute();
  renderSidebar();
  shellEls.main.replaceChildren();

  if (route.page === 'console') {
    shellEls.main.append(shellEls.console);
    shellEls.console.hidden = false;
    if (!terminals.length && !shellEls.opened) {
      shellEls.opened = true;
      state.hosts.forEach((host) => openTerminal(host.id));
    }
    terminals.forEach((t) => t.fit.fit());
    return;
  }

  if (route.page === 'host') {
    const metrics = state.metrics.get(route.hostId);
    const tabs = HOST_TABS.filter(([key]) => key !== 'docker' || !metrics?.online || metrics.hasDocker);
    shellEls.main.append(h('nav', { class: 'tabs', 'aria-label': 'Board sections' },
      tabs.map(([key, label]) => h('a', {
        class: `tab${key === route.tab ? ' active' : ''}`,
        href: `#/${route.hostId}/${key}`,
        'aria-current': key === route.tab ? 'page' : null,
      }, label))));
    const host = state.hosts.find((x) => x.id === route.hostId);
    currentView = views[route.tab](host);
  } else {
    currentView = views.fleet();
  }
  shellEls.main.append(currentView.el);
  currentView.update?.();
}

async function pollMetrics() {
  await Promise.all(state.hosts.map(async (host) => {
    try {
      state.metrics.set(host.id, await api(`hosts/${host.id}/metrics`));
    } catch (err) {
      if (err.message !== 'Signed out') state.metrics.set(host.id, { online: false, error: err.message, history: [] });
    }
  }));
  if (!shellEls) return;
  renderSidebar();
  currentView?.update?.();
}

function startPolling() {
  clearInterval(pollTimer);
  pollMetrics();
  pollTimer = setInterval(pollMetrics, POLL_MS);
}

function showShell() {
  const nav = h('nav', { 'aria-label': 'Main', style: 'display:contents' });
  const main = h('main', { class: 'main' });
  const logout = h('button', {
    onclick: async () => {
      await api('logout', { method: 'POST' }).catch(() => {});
      showLogin();
    },
  }, 'Sign out');
  shellEls = { nav, main };
  const con = buildConsole();
  shellEls.console = con.root;
  shellEls.grid = con.grid;
  shellEls.empty = con.empty;
  shellEls.opened = false;
  document.getElementById('app').replaceChildren(
    h('div', { class: 'shell' },
      h('aside', { class: 'sidebar' },
        h('div', { class: 'brand' }, 'Board Console'),
        nav,
        h('div', { class: 'sidebar-foot' }, logout)),
      main));
  renderRoute();
  startPolling();
}

function showLogin() {
  clearInterval(pollTimer);
  currentView?.destroy?.();
  currentView = null;
  if (shellEls) closeAllTerminals();
  shellEls = null;
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const input = h('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', {
    class: 'panel',
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      try {
        await api('login', { method: 'POST', json: { password: input.value } });
        await start();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    },
  },
  h('h1', {}, 'Board Console'),
  h('label', { for: 'password' }, 'Password'),
  input,
  error,
  h('button', { class: 'primary', type: 'submit' }, 'Sign in'));
  document.getElementById('app').replaceChildren(h('div', { class: 'login' }, form));
  input.focus();
}

async function start() {
  try {
    state.hosts = await api('hosts');
  } catch {
    return;
  }
  showShell();
}

window.addEventListener('hashchange', () => {
  if (shellEls) renderRoute();
});

start();
