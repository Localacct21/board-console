const HISTORY_LENGTH = 120;
const CACHE_MS = 2000;

const SCRIPT = `
echo @@host; hostname
echo @@os; . /etc/os-release; echo "$PRETTY_NAME"; uname -r; uname -m; tr -d '\\0' </proc/device-tree/model 2>/dev/null; echo
echo @@uptime; cat /proc/uptime /proc/loadavg
echo @@stat1; grep '^cpu' /proc/stat; sleep 0.5
echo @@stat2; grep '^cpu' /proc/stat
echo @@mem; cat /proc/meminfo
echo @@disk; df -P -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null
echo @@thermal; for z in /sys/class/thermal/thermal_zone*; do echo "$(cat $z/type 2>/dev/null) $(cat $z/temp 2>/dev/null)"; done
echo @@net; cat /proc/net/dev
echo @@ip; ip -j -4 addr show 2>/dev/null
echo @@failed; systemctl --failed --no-legend --plain --type=service 2>/dev/null
echo @@docker; command -v docker
echo @@reboot; test -f /var/run/reboot-required && echo yes
`;

function sections(output) {
  const out = {};
  let current = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('@@')) {
      current = line.slice(2).trim();
      out[current] = [];
    } else if (current) {
      out[current].push(line);
    }
  }
  return out;
}

const cpuTimes = (lines) => Object.fromEntries(lines.filter(Boolean).map((line) => {
  const [name, ...values] = line.trim().split(/\s+/);
  const nums = values.map(Number);
  const idle = nums[3] + (nums[4] || 0);
  const total = nums.slice(0, 8).reduce((a, b) => a + b, 0);
  return [name, { idle, total }];
}));

function cpuPercent(before, after) {
  const total = after.total - before.total;
  if (total <= 0) return 0;
  return Math.round((1000 * (total - (after.idle - before.idle))) / total) / 10;
}

function parseCpu(s) {
  const a = cpuTimes(s.stat1 ?? []);
  const b = cpuTimes(s.stat2 ?? []);
  const cores = Object.keys(b)
    .filter((k) => k !== 'cpu' && a[k])
    .sort((x, y) => Number(x.slice(3)) - Number(y.slice(3)))
    .map((k) => cpuPercent(a[k], b[k]));
  return { percent: a.cpu && b.cpu ? cpuPercent(a.cpu, b.cpu) : 0, cores };
}

function parseMemory(lines) {
  const kb = {};
  for (const line of lines) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) kb[m[1]] = Number(m[2]) * 1024;
  }
  const available = kb.MemAvailable ?? kb.MemFree ?? 0;
  const total = kb.MemTotal ?? 0;
  return {
    total,
    used: total - available,
    swapTotal: kb.SwapTotal ?? 0,
    swapUsed: (kb.SwapTotal ?? 0) - (kb.SwapFree ?? 0),
  };
}

function parseDisks(lines) {
  return lines.slice(1).filter(Boolean).map((line) => {
    const f = line.trim().split(/\s+/);
    return { device: f[0], total: Number(f[1]), used: Number(f[2]), mount: f.slice(5).join(' ') };
  }).filter((d) => d.total > 0 && !d.mount.startsWith('/var/lib/docker'));
}

function parseThermal(lines) {
  return lines
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length === 2 && /^-?\d+$/.test(f[1]))
    .map(([name, milli]) => ({ name: name.replace(/[-_]thermal$/, ''), celsius: Number(milli) / 1000 }));
}

function parseNet(lines, ipLines) {
  let addresses = [];
  try {
    addresses = JSON.parse(ipLines.join('\n'));
  } catch { /* ip -j unavailable */ }
  const ipByName = new Map(addresses.map((a) => [a.ifname, a.addr_info?.[0]?.local]));
  const stateByName = new Map(addresses.map((a) => [a.ifname, a.operstate]));
  return lines.slice(2).filter(Boolean).map((line) => {
    const [name, rest] = line.split(':');
    const f = rest.trim().split(/\s+/).map(Number);
    return { name: name.trim(), rx: f[0], tx: f[8], ip: ipByName.get(name.trim()) ?? null, state: stateByName.get(name.trim()) ?? null };
  }).filter((n) => n.name !== 'lo' && !/^(veth|docker|br-|virbr)/.test(n.name));
}

function parse(output) {
  const s = sections(output);
  const [pretty, kernel, arch, model] = s.os ?? [];
  const [uptime, loadavg] = s.uptime ?? [];
  return {
    hostname: s.host?.[0]?.trim() ?? '',
    os: pretty ?? '',
    kernel: kernel ?? '',
    arch: arch ?? '',
    model: model?.trim() ?? '',
    uptime: Number(uptime?.split(' ')[0] ?? 0),
    load: (loadavg ?? '').split(' ').slice(0, 3).map(Number),
    cpu: parseCpu(s),
    memory: parseMemory(s.mem ?? []),
    disks: parseDisks(s.disk ?? []),
    thermal: parseThermal(s.thermal ?? []),
    network: parseNet(s.net ?? [], s.ip ?? []),
    failedUnits: (s.failed ?? []).filter(Boolean).map((l) => l.trim().split(/\s+/)[0]),
    hasDocker: Boolean(s.docker?.[0]?.trim()),
    rebootRequired: s.reboot?.[0]?.trim() === 'yes',
  };
}

/** Polls one board on demand and keeps a short history for charts. */
export class MetricsCollector {
  constructor(board) {
    this.board = board;
    this.history = [];
    this.last = null;
    this.prevNet = null;
    this.inflight = null;
  }

  async sample() {
    const { stdout } = await this.board.run(SCRIPT, { timeout: 10000 });
    const data = parse(stdout);
    const now = Date.now();

    const rxTotal = data.network.reduce((sum, n) => sum + n.rx, 0);
    const txTotal = data.network.reduce((sum, n) => sum + n.tx, 0);
    let rxRate = null;
    let txRate = null;
    if (this.prevNet) {
      const seconds = (now - this.prevNet.t) / 1000;
      // Counters restart at zero after a reboot, which would read as a negative rate.
      if (rxTotal >= this.prevNet.rx && txTotal >= this.prevNet.tx) {
        rxRate = (rxTotal - this.prevNet.rx) / seconds;
        txRate = (txTotal - this.prevNet.tx) / seconds;
      }
    }
    this.prevNet = { t: now, rx: rxTotal, tx: txTotal };

    const temp = data.thermal.length ? Math.max(...data.thermal.map((z) => z.celsius)) : null;
    const memPercent = data.memory.total ? (100 * data.memory.used) / data.memory.total : 0;
    this.history.push({ t: now, cpu: data.cpu.percent, mem: Math.round(memPercent * 10) / 10, temp, rx: rxRate, tx: txRate });
    if (this.history.length > HISTORY_LENGTH) this.history.shift();

    this.last = { ...data, temp, rxRate, txRate, t: now, online: true };
    return this.last;
  }

  async get() {
    if (this.last?.online && Date.now() - this.last.t < CACHE_MS) {
      return { ...this.last, history: this.history };
    }
    if (!this.inflight) {
      this.inflight = this.sample().finally(() => { this.inflight = null; });
    }
    const data = await this.inflight;
    return { ...data, history: this.history };
  }

  invalidate() {
    if (this.last) this.last = { ...this.last, online: false };
    this.prevNet = null;
  }
}
