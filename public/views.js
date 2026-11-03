import { api, confirmDialog, h, openTerminal, state, toast } from './app.js';
import { LineChart } from './charts.js';

/* Formatting */
export function bytes(n) {
  if (n === null || n === undefined) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function duration(seconds) {
  const d = Math.floor(seconds / 86400);
  const hrs = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${hrs}h`;
  if (hrs) return `${hrs}h ${m}m`;
  return `${m}m`;
}

const percent = (used, total) => (total ? (100 * used) / total : 0);
const severity = (value, warn, crit) => (value >= crit ? 'critical' : value >= warn ? 'warning' : 'good');
const seriesVar = (n) => `var(--series-${n})`;

function statusBadge(level, label) {
  return h('span', { class: `status ${level}` }, label);
}

function meter(value, level) {
  const clamped = Math.min(100, Math.max(0, value));
  return h('div', { class: `meter ${level}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(clamped) },
    h('span', { style: `width:${clamped.toFixed(1)}%` }));
}

function meterRow(name, value, level, text) {
  return h('div', { class: 'meter-row' },
    h('div', { class: 'meter-name', title: name }, name),
    meter(value, level),
    h('div', { class: 'meter-value' }, text));
}

function tile(label, value, note, level) {
  return h('div', {},
    h('div', { class: 'tile-label' }, label),
    h('div', { class: 'tile-value' }, value),
    level && level !== 'good'
      ? statusBadge(level, level === 'critical' ? 'Critical' : 'High')
      : h('div', { class: 'tile-note' }, note ?? ''));
}

function rootDisk(m) {
  return m.disks.find((d) => d.mount === '/') ?? m.disks[0];
}

function summaryTiles(m) {
  const disk = rootDisk(m);
  const memPct = percent(m.memory.used, m.memory.total);
  const diskPct = disk ? percent(disk.used, disk.total) : 0;
  return h('div', { class: 'tiles' },
    tile('CPU', `${Math.round(m.cpu.percent)}%`, `Load ${m.load[0].toFixed(2)}`, severity(m.cpu.percent, 85, 95)),
    tile('Memory', `${Math.round(memPct)}%`, `${bytes(m.memory.used)} of ${bytes(m.memory.total)}`, severity(memPct, 85, 95)),
    tile('Temperature', m.temp === null ? 'n/a' : `${Math.round(m.temp)}°C`, 'Hottest sensor', m.temp === null ? 'good' : severity(m.temp, 70, 80)),
    tile('Disk', disk ? `${Math.round(diskPct)}%` : 'n/a', disk ? `${bytes(disk.used)} of ${bytes(disk.total)}` : '', severity(diskPct, 85, 95)),
    tile('Uptime', duration(m.uptime), m.rebootRequired ? 'Reboot required' : ''));
}

function offlinePanel(host, m) {
  return h('div', { class: 'panel' },
    statusBadge('critical', 'Offline'),
    h('p', { class: 'subtle' }, `Cannot reach ${host.host}. ${m?.error ?? ''}`));
}

/* All boards */
export function fleet() {
  const cards = new Map();
  const grid = h('div', { class: 'grid-2' });
  const el = h('div', { class: 'page' }, h('h1', {}, 'All boards'), grid);
  for (const host of state.hosts) {
    const chart = new LineChart({ series: [{ key: 'cpu', label: 'CPU', color: seriesVar(1) }], height: 100, max: 100, format: (v) => `${Math.round(v)}%`, ariaLabel: `${host.name} CPU history` });
    const status = h('span', {});
    const tiles = h('div', {});
    const issues = h('div', {});
    const actions = h('div', { class: 'row' },
      h('a', { href: `#/${host.id}` }, 'Manage'),
      h('button', {
        onclick: () => {
          location.hash = '#/console';
        },
      }, 'Open console'));
    const card = h('section', { class: 'panel board-card', 'aria-label': host.name },
      h('div', { class: 'board-title' }, h('a', { href: `#/${host.id}` }, host.name), status),
      tiles,
      h('div', {}, h('h3', {}, 'CPU history'), chart.el),
      issues,
      actions);
    cards.set(host.id, { chart, status, tiles, issues });
    grid.append(card);
  }
  return {
    el,
    update() {
      for (const host of state.hosts) {
        const m = state.metrics.get(host.id);
        const c = cards.get(host.id);
        if (!m) {
          c.status.replaceChildren(h('span', { class: 'muted' }, 'Connecting'));
          continue;
        }
        c.chart.update(m.history ?? []);
        if (!m.online) {
          c.status.replaceChildren(statusBadge('critical', 'Offline'));
          c.tiles.replaceChildren(h('p', { class: 'subtle' }, m.error ?? 'Unreachable'));
          c.issues.replaceChildren();
          continue;
        }
        c.status.replaceChildren(m.failedUnits.length
          ? statusBadge('warning', `${m.failedUnits.length} failed service${m.failedUnits.length > 1 ? 's' : ''}`)
          : statusBadge('good', 'Online'));
        c.tiles.replaceChildren(summaryTiles(m));
        c.issues.replaceChildren(...(m.failedUnits.length
          ? [h('div', { class: 'subtle' }, 'Failed: ', h('span', { class: 'mono' }, m.failedUnits.join(', ')))]
          : []));
      }
    },
    destroy() {
      cards.forEach((c) => c.chart.destroy());
    },
  };
}

/* Board overview */
export function overview(host) {
  const rate = (v) => `${bytes(v)}/s`;
  const charts = {
    cpu: new LineChart({ series: [{ key: 'cpu', label: 'CPU', color: seriesVar(1) }], max: 100, format: (v) => `${Math.round(v)}%`, ariaLabel: 'CPU history' }),
    mem: new LineChart({ series: [{ key: 'mem', label: 'Memory', color: seriesVar(1) }], max: 100, format: (v) => `${Math.round(v)}%`, ariaLabel: 'Memory history' }),
    temp: new LineChart({ series: [{ key: 'temp', label: 'Temperature', color: seriesVar(1) }], max: 100, format: (v) => `${Math.round(v)}°C`, ariaLabel: 'Temperature history' }),
    net: new LineChart({ series: [{ key: 'rx', label: 'Received', color: seriesVar(1) }, { key: 'tx', label: 'Sent', color: seriesVar(2) }], format: rate, ariaLabel: 'Network throughput history' }),
  };
  const facts = h('p', { class: 'subtle', style: 'margin:4px 0 0' });
  const body = h('div', { class: 'page', style: 'padding:0' });
  const dynamic = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  const chartsEl = h('div', { class: 'grid-2' },
    h('section', { class: 'panel' }, h('h2', {}, 'CPU'), charts.cpu.el),
    h('section', { class: 'panel' }, h('h2', {}, 'Memory'), charts.mem.el),
    h('section', { class: 'panel' }, h('h2', {}, 'Temperature'), charts.temp.el),
    h('section', { class: 'panel' }, h('h2', {}, 'Network'), charts.net.el));
  const details = h('div', { class: 'grid-2' });
  const summary = h('section', { class: 'panel' });
  dynamic.append(summary, chartsEl, details);
  body.append(dynamic);

  const powerAction = async (action, label) => {
    const ok = await confirmDialog({
      title: `${label} ${host.name}?`,
      body: action === 'poweroff'
        ? 'The board stays off until someone restores its power. You cannot turn it back on from here.'
        : 'Open terminals and running work on this board will be interrupted.',
      confirmLabel: label,
      typed: host.id,
    });
    if (!ok) return;
    try {
      await api(`hosts/${host.id}/power`, { method: 'POST', json: { action, confirm: host.id } });
      toast(`${label} sent to ${host.name}`);
    } catch (err) {
      toast(err.message, true);
    }
  };

  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' }, h('h1', {}, host.name), facts),
      h('div', { class: 'row' },
        h('button', {
          onclick: () => {
            openTerminal(host.id);
            location.hash = '#/console';
          },
        }, 'Open shell'),
        h('button', { class: 'danger', onclick: () => powerAction('reboot', 'Reboot') }, 'Reboot'),
        h('button', { class: 'danger', onclick: () => powerAction('poweroff', 'Shut down') }, 'Shut down'))),
    body);

  return {
    el,
    update() {
      const m = state.metrics.get(host.id);
      if (!m) return;
      Object.entries(charts).forEach(([, chart]) => chart.update(m.history ?? []));
      if (!m.online) {
        facts.textContent = `${host.user}@${host.host}`;
        summary.replaceChildren(offlinePanel(host, m));
        details.replaceChildren();
        return;
      }
      facts.textContent = [m.model, m.os, `kernel ${m.kernel}`].filter(Boolean).join(' · ');
      summary.replaceChildren(summaryTiles(m));
      details.replaceChildren(
        h('section', { class: 'panel' }, h('h2', {}, `CPU cores (${m.cpu.cores.length})`),
          h('div', { class: 'cores' }, m.cpu.cores.map((v, i) => meterRow(`${i}`, v, severity(v, 85, 95), `${Math.round(v)}%`)))),
        h('section', { class: 'panel' }, h('h2', {}, 'Storage'),
          m.disks.map((d) => {
            const pct = percent(d.used, d.total);
            return meterRow(d.mount, pct, severity(pct, 85, 95), `${bytes(d.used)} / ${bytes(d.total)}`);
          })),
        h('section', { class: 'panel' }, h('h2', {}, 'Sensors'),
          m.thermal.length
            ? h('div', { class: 'table-wrap' }, h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Sensor'), h('th', { class: 'num' }, 'Temperature'))),
              h('tbody', {}, m.thermal.map((z) => h('tr', {}, h('td', {}, z.name), h('td', { class: 'num' }, `${z.celsius.toFixed(1)}°C`))))))
            : h('p', { class: 'muted' }, 'No thermal sensors reported.')),
        h('section', { class: 'panel' }, h('h2', {}, 'Network interfaces'),
          h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Interface'), h('th', {}, 'Address'), h('th', {}, 'State'), h('th', { class: 'num' }, 'Received'), h('th', { class: 'num' }, 'Sent'))),
            h('tbody', {}, m.network.map((n) => h('tr', {},
              h('td', { class: 'mono' }, n.name), h('td', { class: 'mono' }, n.ip ?? ''), h('td', {}, (n.state ?? '').toLowerCase()),
              h('td', { class: 'num' }, bytes(n.rx)), h('td', { class: 'num' }, bytes(n.tx)))))))),
        ...(m.failedUnits.length
          ? [h('section', { class: 'panel' }, h('h2', {}, 'Failed services'),
            m.failedUnits.map((u) => h('div', {}, h('a', { class: 'mono', href: `#/${host.id}/logs`, onclick: () => { logUnits.set(host.id, u); } }, u))))]
          : []),
      );
    },
    destroy() {
      Object.values(charts).forEach((c) => c.destroy());
    },
  };
}

/* Shared list page behaviour */
function listPage({ title, load, render, filterLabel, intro, autoRefreshMs }) {
  const content = h('div', { class: 'panel' }, h('p', { class: 'muted' }, 'Loading'));
  const filter = filterLabel ? h('input', { type: 'search', placeholder: filterLabel, 'aria-label': filterLabel, oninput: () => paint() }) : null;
  const refreshBtn = h('button', { onclick: () => refresh() }, 'Refresh');
  let data = null;
  let timer = null;
  let loadSeq = 0;

  function paint() {
    if (data === null) return;
    content.replaceChildren(render(data, (filter?.value ?? '').trim().toLowerCase(), refresh));
  }
  async function refresh() {
    const seq = ++loadSeq;
    refreshBtn.disabled = true;
    try {
      const result = await load();
      if (seq !== loadSeq) return;
      data = result;
      paint();
    } catch (err) {
      if (seq === loadSeq && data === null) content.replaceChildren(h('p', { class: 'error' }, err.message));
      else if (seq === loadSeq) toast(err.message, true);
    } finally {
      refreshBtn.disabled = false;
    }
  }
  refresh();
  if (autoRefreshMs) timer = setInterval(() => { if (!document.hidden) refresh(); }, autoRefreshMs);

  return {
    el: h('div', { class: 'page' },
      h('div', { class: 'page-head' },
        h('h1', {}, title),
        h('div', { class: 'row' }, filter, refreshBtn)),
      intro,
      content),
    destroy() {
      clearInterval(timer);
      loadSeq += 1;
    },
  };
}

async function runAction(button, label, fn, after) {
  button.disabled = true;
  try {
    await fn();
    toast(label);
    await after?.();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

/* Services */
export function services(host) {
  return listPage({
    title: `${host.name} services`,
    filterLabel: 'Filter services',
    load: () => api(`hosts/${host.id}/services`),
    render(units, q, refresh) {
      const order = (u) => (u.active === 'failed' ? 0 : u.active === 'active' ? 1 : 2);
      const rows = units
        .filter((u) => !q || u.name.toLowerCase().includes(q) || u.description.toLowerCase().includes(q))
        .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
      const act = (u, action, label, needsConfirm) => {
        const button = h('button', {
          onclick: async () => {
            if (needsConfirm && !await confirmDialog({
              title: `${label} ${u.name}?`,
              body: `This runs "systemctl ${action} ${u.name}" on ${host.name}.`,
              confirmLabel: label,
            })) return;
            await runAction(button, `${label}: ${u.name} on ${host.name}`, () => api(`hosts/${host.id}/services/${encodeURIComponent(u.name)}/${action}`, { method: 'POST' }), refresh);
          },
        }, label);
        return button;
      };
      const stateBadge = (u) => {
        if (u.active === 'failed') return statusBadge('critical', 'Failed');
        if (u.active === 'active') return statusBadge('good', u.sub);
        return h('span', { class: 'muted' }, u.sub);
      };
      return h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Service'), h('th', {}, 'State'), h('th', {}, 'At boot'), h('th', {}, 'Description'), h('th', { class: 'num' }, 'Actions'))),
        h('tbody', {}, rows.map((u) => {
          const canToggleBoot = u.enabled === 'enabled' || u.enabled === 'disabled';
          return h('tr', {},
            h('td', { class: 'mono' }, u.name),
            h('td', {}, stateBadge(u)),
            h('td', {}, u.enabled),
            h('td', { class: 'wrap subtle' }, u.description),
            h('td', { class: 'actions' },
              h('a', { href: `#/${host.id}/logs`, onclick: () => { logUnits.set(host.id, u.name); } }, 'Logs'),
              u.active === 'active' ? [act(u, 'restart', 'Restart', true), act(u, 'stop', 'Stop', true)] : act(u, 'start', 'Start', false),
              canToggleBoot && (u.enabled === 'enabled' ? act(u, 'disable', 'Disable', true) : act(u, 'enable', 'Enable', true))));
        }))));
    },
  });
}

/* Docker */
export function docker(host) {
  const logBox = h('div', {});
  const view = listPage({
    title: `${host.name} containers`,
    filterLabel: 'Filter containers',
    intro: logBox,
    load: () => api(`hosts/${host.id}/containers`),
    render(items, q, refresh) {
      const rows = items.filter((c) => !q || `${c.name} ${c.image}`.toLowerCase().includes(q));
      if (!items.length) return h('p', { class: 'muted' }, 'No containers on this board.');
      const act = (c, action, label) => {
        const button = h('button', {
          onclick: async () => {
            if (action !== 'start' && !await confirmDialog({ title: `${label} ${c.name}?`, body: `This runs "docker ${action}" on ${host.name}.`, confirmLabel: label })) return;
            await runAction(button, `${label}: ${c.name}`, () => api(`hosts/${host.id}/containers/${c.id}/${action}`, { method: 'POST' }), refresh);
          },
        }, label);
        return button;
      };
      const showLogs = async (c) => {
        logBox.replaceChildren(h('div', { class: 'panel' }, h('p', { class: 'muted' }, `Loading logs for ${c.name}`)));
        try {
          const { text } = await api(`hosts/${host.id}/containers/${c.id}/logs?lines=300`);
          const pre = h('pre', { class: 'log', tabindex: 0 }, text || '(no output)');
          logBox.replaceChildren(h('section', { class: 'panel' },
            h('div', { class: 'page-head', style: 'margin-bottom:8px' }, h('h2', {}, `${c.name} logs`), h('button', { onclick: () => logBox.replaceChildren() }, 'Close')),
            pre));
          pre.scrollTop = pre.scrollHeight;
        } catch (err) {
          logBox.replaceChildren();
          toast(err.message, true);
        }
      };
      return h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Image'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'CPU'), h('th', { class: 'num' }, 'Memory'), h('th', {}, 'Ports'), h('th', { class: 'num' }, 'Actions'))),
        h('tbody', {}, rows.map((c) => h('tr', {},
          h('td', {}, c.name),
          h('td', { class: 'mono wrap' }, c.image),
          h('td', {}, c.state === 'running' ? statusBadge('good', c.status) : h('span', { class: 'muted' }, c.status)),
          h('td', { class: 'num' }, c.cpu ?? ''),
          h('td', { class: 'num' }, c.mem?.split(' / ')[0] ?? ''),
          h('td', { class: 'mono wrap' }, c.ports),
          h('td', { class: 'actions' },
            h('button', { onclick: () => showLogs(c) }, 'Logs'),
            c.state === 'running' ? [act(c, 'restart', 'Restart'), act(c, 'stop', 'Stop')] : act(c, 'start', 'Start')))))));
    },
  });
  return view;
}

/* Processes */
export function processes(host) {
  return listPage({
    title: `${host.name} processes`,
    filterLabel: 'Filter processes',
    autoRefreshMs: 5000,
    load: () => api(`hosts/${host.id}/processes`),
    render(items, q, refresh) {
      const rows = items.filter((p) => !q || `${p.command} ${p.user} ${p.pid}`.toLowerCase().includes(q));
      const send = (p, signal, label) => {
        const button = h('button', {
          class: signal === 'KILL' ? 'danger' : null,
          onclick: async () => {
            if (!await confirmDialog({
              title: `${label} process ${p.pid}?`,
              body: `Sends SIG${signal} on ${host.name} to: ${p.command}`,
              confirmLabel: label,
            })) return;
            await runAction(button, `SIG${signal} sent to ${p.pid}`, () => api(`hosts/${host.id}/processes/${p.pid}`, { method: 'POST', json: { signal } }), refresh);
          },
        }, label);
        return button;
      };
      return h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { class: 'num' }, 'PID'), h('th', {}, 'User'), h('th', { class: 'num' }, 'CPU'), h('th', { class: 'num' }, 'Memory'), h('th', { class: 'num' }, 'Running'), h('th', {}, 'Command'), h('th', { class: 'num' }, 'Actions'))),
        h('tbody', {}, rows.map((p) => h('tr', {},
          h('td', { class: 'num' }, String(p.pid)),
          h('td', {}, p.user),
          h('td', { class: 'num' }, `${p.cpu.toFixed(1)}%`),
          h('td', { class: 'num' }, bytes(p.rss)),
          h('td', { class: 'num' }, duration(p.elapsed)),
          h('td', { class: 'mono wrap' }, p.command),
          h('td', { class: 'actions' }, send(p, 'TERM', 'Stop'), send(p, 'KILL', 'Kill')))))));
    },
  });
}

/* Logs */
const logUnits = new Map();

export function logs(host) {
  const unit = h('input', { type: 'search', placeholder: 'All services, or e.g. ssh.service', 'aria-label': 'Service', value: logUnits.get(host.id) ?? '', style: 'min-width:220px' });
  logUnits.delete(host.id);
  const priority = h('select', { 'aria-label': 'Minimum severity' },
    h('option', { value: '' }, 'All severities'),
    h('option', { value: '4' }, 'Warnings and above'),
    h('option', { value: '3' }, 'Errors and above'));
  const lines = h('select', { 'aria-label': 'Lines' }, [200, 500, 2000].map((n) => h('option', { value: String(n) }, `${n} lines`)));
  const follow = h('input', { type: 'checkbox', id: 'follow-logs', style: 'min-height:0' });
  const pre = h('pre', { class: 'log', tabindex: 0, 'aria-label': 'Log output' }, 'Loading');
  let seq = 0;

  async function load() {
    const current = ++seq;
    const params = new URLSearchParams({ lines: lines.value });
    if (unit.value.trim()) params.set('unit', unit.value.trim());
    if (priority.value) params.set('priority', priority.value);
    try {
      const { text } = await api(`hosts/${host.id}/journal?${params}`);
      if (current !== seq) return;
      const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
      pre.textContent = text || '(no matching entries)';
      if (atBottom || pre.dataset.fresh !== 'no') pre.scrollTop = pre.scrollHeight;
      pre.dataset.fresh = 'no';
    } catch (err) {
      if (current === seq) pre.textContent = err.message;
    }
  }
  const timer = setInterval(() => { if (follow.checked && !document.hidden) load(); }, 3000);
  const reload = () => {
    pre.dataset.fresh = 'yes';
    load();
  };
  unit.addEventListener('change', reload);
  priority.addEventListener('change', reload);
  lines.addEventListener('change', reload);
  load();

  return {
    el: h('div', { class: 'page' },
      h('div', { class: 'page-head' },
        h('h1', {}, `${host.name} logs`),
        h('div', { class: 'row' }, unit, priority, lines,
          h('label', { class: 'row', for: 'follow-logs', style: 'gap:4px' }, follow, 'Follow'),
          h('button', { onclick: reload }, 'Refresh'))),
      pre),
    destroy() {
      clearInterval(timer);
      seq += 1;
    },
  };
}

/* Files */
const filePaths = new Map();

export function files(host) {
  let path = filePaths.get(host.id) ?? '/';
  const crumbs = h('div', { class: 'row mono', style: 'gap:2px' });
  const content = h('div', { class: 'panel' }, h('p', { class: 'muted' }, 'Loading'));
  const upload = h('input', {
    type: 'file',
    hidden: true,
    onchange: async () => {
      const file = upload.files[0];
      upload.value = '';
      if (!file) return;
      const target = `${path.replace(/\/$/, '')}/${file.name}`;
      try {
        await api(`hosts/${host.id}/files?path=${encodeURIComponent(target)}`, { method: 'POST', body: file });
        toast(`Uploaded ${target}`);
        navigate(path);
      } catch (err) {
        toast(err.message, true);
      }
    },
  });

  const join = (base, name) => `${base.replace(/\/$/, '')}/${name}`;

  async function navigate(next) {
    try {
      const data = await api(`hosts/${host.id}/files?path=${encodeURIComponent(next)}`);
      path = data.path;
      filePaths.set(host.id, path);
      paintCrumbs();
      content.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { class: 'num' }, 'Size'), h('th', {}, 'Mode'), h('th', {}, 'Modified'), h('th', { class: 'num' }, 'Actions'))),
        h('tbody', {}, data.entries.map((e) => {
          const full = join(path, e.name);
          const opens = e.kind === 'dir' || e.kind === 'link';
          return h('tr', {},
            h('td', { class: 'mono wrap' }, opens
              ? h('button', { class: 'link-button mono', onclick: () => navigate(full) }, `${e.name}${e.kind === 'dir' ? '/' : ' →'}`)
              : e.name),
            h('td', { class: 'num' }, e.kind === 'dir' ? '' : bytes(e.size)),
            h('td', { class: 'mono' }, e.mode),
            h('td', { class: 'subtle' }, e.mtime ? new Date(e.mtime).toLocaleString() : ''),
            h('td', { class: 'actions' }, e.kind === 'file' && h('a', { href: `/api/hosts/${host.id}/files/download?path=${encodeURIComponent(full)}`, download: e.name }, 'Download')));
        })))));
    } catch (err) {
      toast(err.message, true);
      if (content.querySelector('.muted')) content.replaceChildren(h('p', { class: 'error' }, err.message));
    }
  }

  function paintCrumbs() {
    const parts = path.split('/').filter(Boolean);
    crumbs.replaceChildren(
      h('button', { class: 'link-button mono', onclick: () => navigate('/') }, '/'),
      ...parts.flatMap((part, i) => {
        const target = `/${parts.slice(0, i + 1).join('/')}`;
        return [h('button', { class: 'link-button mono', onclick: () => navigate(target) }, part), i < parts.length - 1 ? h('span', { class: 'muted' }, '/') : null].filter(Boolean);
      }),
    );
  }

  navigate(path);
  return {
    el: h('div', { class: 'page' },
      h('div', { class: 'page-head' },
        h('h1', {}, `${host.name} files`),
        h('div', { class: 'row' }, upload, h('button', { onclick: () => upload.click() }, 'Upload here'), h('button', { onclick: () => navigate(path) }, 'Refresh'))),
      crumbs,
      content),
  };
}

/* Updates */
export function updates(host) {
  const shell = (text) => {
    openTerminal(host.id, text);
    location.hash = '#/console';
  };
  return listPage({
    title: `${host.name} updates`,
    load: () => api(`hosts/${host.id}/updates`),
    intro: h('div', { class: 'row' },
      h('button', { onclick: () => shell('apt update') }, 'Check in terminal'),
      h('button', { onclick: () => shell('apt update && apt upgrade') }, 'Upgrade in terminal'),
      h('span', { class: 'muted' }, 'The command is typed for you. Press Enter to run it.')),
    render(data) {
      const age = data.listsUpdatedAt ? `Package lists last refreshed ${new Date(data.listsUpdatedAt).toLocaleString()}.` : '';
      if (!data.packages.length) return h('div', {}, h('p', { style: 'margin:0' }, statusBadge('good', 'Up to date')), h('p', { class: 'muted' }, age));
      return h('div', {},
        h('p', { style: 'margin-top:0' }, `${data.packages.length} package${data.packages.length > 1 ? 's' : ''} can be upgraded. `, h('span', { class: 'muted' }, age)),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Package'), h('th', {}, 'Installed'), h('th', {}, 'Available'))),
          h('tbody', {}, data.packages.map((p) => h('tr', {}, h('td', { class: 'mono' }, p.name), h('td', { class: 'mono wrap' }, p.from), h('td', { class: 'mono wrap' }, p.version)))))));
    },
  });
}
