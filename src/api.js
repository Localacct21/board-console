import { posix } from 'node:path';
import { shq } from './ssh.js';

const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@:._-]*\.service$/;
const CONTAINER_RE = /^[a-f0-9]{6,64}$/;
const SSH_UNIT_RE = /^(ssh|sshd|dropbear)(@.*)?\.service$/;
const UNIT_ACTIONS = new Set(['start', 'stop', 'restart', 'enable', 'disable']);
const CONTAINER_ACTIONS = new Set(['start', 'stop', 'restart']);
const SIGNALS = new Set(['TERM', 'KILL']);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const clamp = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
};

function requireOk(result, what) {
  if (result.code !== 0) {
    throw new HttpError(502, `${what} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  }
  return result;
}

function checkedPath(value) {
  const path = String(value ?? '');
  if (!path.startsWith('/') || path.includes('\0')) throw new HttpError(400, 'Path must be absolute');
  return posix.normalize(path);
}

export async function services(board) {
  const [units, files] = await Promise.all([
    board.run('systemctl list-units --type=service --all --no-legend --plain --no-pager'),
    board.run('systemctl list-unit-files --type=service --no-legend --plain --no-pager'),
  ]);
  requireOk(units, 'Listing services');
  const enablement = new Map(files.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, state] = line.trim().split(/\s+/);
    return [name, state];
  }));
  return units.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, load, active, sub, ...description] = line.trim().split(/\s+/);
    return { name, load, active, sub, description: description.join(' '), enabled: enablement.get(name) ?? 'unknown' };
  }).filter((u) => u.load !== 'not-found' && UNIT_RE.test(u.name));
}

export async function serviceAction(board, unit, action) {
  if (!UNIT_RE.test(unit)) throw new HttpError(400, 'Invalid service name');
  if (!UNIT_ACTIONS.has(action)) throw new HttpError(400, 'Invalid action');
  if (SSH_UNIT_RE.test(unit) && (action === 'stop' || action === 'disable')) {
    throw new HttpError(409, `Refusing to ${action} ${unit} because it would cut off this console. Use a terminal if you really mean to.`);
  }
  requireOk(await board.run(`systemctl ${action} ${shq(unit)}`, { timeout: 60000 }), `${action} ${unit}`);
  return { ok: true };
}

export async function processes(board) {
  const { stdout } = requireOk(
    await board.run('ps -eo pid=,user:16=,pcpu=,pmem=,rss=,etimes=,stat=,args= --sort=-pcpu --cols 300'),
    'Listing processes',
  );
  return stdout.split('\n').filter(Boolean).map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) return null;
    return { pid: Number(m[1]), user: m[2], cpu: Number(m[3]), mem: Number(m[4]), rss: Number(m[5]) * 1024, elapsed: Number(m[6]), stat: m[7], command: m[8] };
  }).filter((p) => p && !p.command.startsWith('ps -eo pid=')); // hide this listing's own ps
}

export async function signalProcess(board, pid, signal) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) throw new HttpError(400, 'Invalid process id');
  if (!SIGNALS.has(signal)) throw new HttpError(400, 'Invalid signal');
  requireOk(await board.run(`kill -s ${signal} ${n}`), `Signal ${n}`);
  return { ok: true };
}

export async function containers(board) {
  const format = '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}';
  const statsFormat = '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}';
  const [list, stats] = await Promise.all([
    board.run(`docker ps -a --no-trunc=false --format ${shq(format)}`),
    board.run(`docker stats --no-stream --format ${shq(statsFormat)}`, { timeout: 20000 }),
  ]);
  requireOk(list, 'Listing containers');
  const usage = new Map(stats.stdout.split('\n').filter(Boolean).map((line) => {
    const [id, cpu, mem] = line.split('\t');
    return [id, { cpu, mem }];
  }));
  return list.stdout.split('\n').filter(Boolean).map((line) => {
    const [id, name, image, state, status, ports] = line.split('\t');
    return { id, name, image, state, status, ports, cpu: usage.get(id)?.cpu ?? null, mem: usage.get(id)?.mem ?? null };
  });
}

export async function containerAction(board, id, action) {
  if (!CONTAINER_RE.test(id)) throw new HttpError(400, 'Invalid container id');
  if (!CONTAINER_ACTIONS.has(action)) throw new HttpError(400, 'Invalid action');
  requireOk(await board.run(`docker ${action} ${id}`, { timeout: 60000 }), `${action} container`);
  return { ok: true };
}

export async function containerLogs(board, id, lines) {
  if (!CONTAINER_RE.test(id)) throw new HttpError(400, 'Invalid container id');
  const result = requireOk(await board.run(`docker logs --tail ${clamp(lines, 10, 2000, 200)} ${id} 2>&1`), 'Reading logs');
  return { text: result.stdout };
}

export async function journal(board, { unit, lines, priority }) {
  const args = ['journalctl', '--no-pager', '-o', 'short-iso', '-n', String(clamp(lines, 10, 2000, 200))];
  if (unit) {
    if (!UNIT_RE.test(unit)) throw new HttpError(400, 'Invalid service name');
    args.push('-u', shq(unit));
  }
  if (priority !== undefined && priority !== null && priority !== '') {
    args.push('-p', String(clamp(priority, 0, 7, 7)));
  }
  const result = requireOk(await board.run(args.join(' ')), 'Reading journal');
  return { text: result.stdout };
}

export async function updates(board) {
  const result = requireOk(await board.run('apt list --upgradable 2>/dev/null', { timeout: 30000 }), 'Listing updates');
  const packages = result.stdout.split('\n').map((line) => {
    const m = line.match(/^([^/\s]+)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/);
    return m && { name: m[1], version: m[2], from: m[3] };
  }).filter(Boolean);
  const stamp = await board.run('stat -c %Y /var/lib/apt/lists 2>/dev/null');
  return { packages, listsUpdatedAt: Number(stamp.stdout.trim()) * 1000 || null };
}

export async function power(board, config, action, confirm) {
  if (action !== 'reboot' && action !== 'poweroff') throw new HttpError(400, 'Invalid action');
  if (confirm !== config.id) throw new HttpError(400, 'Confirmation text does not match');
  // The delay lets this response return before SSH goes away.
  await board.run(`nohup sh -c 'sleep 1; systemctl ${action}' >/dev/null 2>&1 &`);
  return { ok: true };
}

const FILE_KINDS = { d: 'dir', f: 'file', l: 'link' };

/* Files go over plain exec channels because Dropbear boards often have no SFTP server. */
export async function listFiles(board, rawPath) {
  const path = checkedPath(rawPath);
  const dir = shq(path);
  const result = requireOk(await board.run(
    `test -d ${dir} || { echo 'Not a directory' >&2; exit 2; }; find -H ${dir} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%m\\t%f\\0'`,
  ), path);
  const entries = result.stdout.split('\0').filter(Boolean).map((record) => {
    const [kind, size, mtime, mode, ...name] = record.split('\t');
    return {
      name: name.join('\t'),
      kind: FILE_KINDS[kind] ?? 'other',
      size: Number(size),
      mtime: Number(mtime) * 1000,
      mode: mode.padStart(3, '0'),
    };
  }).sort((a, b) => ((a.kind === 'dir') === (b.kind === 'dir') ? a.name.localeCompare(b.name) : (a.kind === 'dir' ? -1 : 1)));
  return { path, entries };
}

export async function downloadFile(board, rawPath, res) {
  const path = checkedPath(rawPath);
  const info = await board.run(`stat -Lc '%F|%s' ${shq(path)}`);
  if (info.code !== 0) throw new HttpError(404, `${path} not found`);
  const [type, size] = info.stdout.trim().split('|');
  if (!type.startsWith('regular')) throw new HttpError(400, 'Only regular files can be downloaded');
  const stream = await board.stream(`cat ${shq(path)}`);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(posix.basename(path))}`,
  });
  res.on('close', () => stream.close());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export async function uploadFile(board, rawPath, req) {
  const path = checkedPath(rawPath);
  const quoted = shq(path);
  const check = await board.run(`test -e ${quoted}`);
  if (check.code === 0) throw new HttpError(409, `${path} already exists. Uploads never overwrite files.`);
  // noclobber makes the shell refuse to replace a file created since the check above.
  const stream = await board.stream(`set -C; cat > ${quoted}`);
  let stderr = '';
  let finished = false;
  let aborted = false;
  // The channel only closes once its stdout has been consumed.
  stream.resume();
  stream.stderr.on('data', (d) => { stderr += d; });
  req.on('end', () => { finished = true; });
  const code = await new Promise((resolve, reject) => {
    stream.on('close', resolve);
    stream.on('error', reject);
    req.on('close', () => {
      if (!finished) {
        aborted = true;
        stream.close();
      }
    });
    req.pipe(stream);
  });
  req.unpipe(stream);
  // Only a client abort leaves our own partial file. A refused write may mean the file is someone else's.
  if (aborted) {
    await board.run(`rm -f -- ${quoted}`);
    throw new HttpError(400, 'Upload interrupted; partial file removed');
  }
  if (code !== 0) throw new HttpError(400, `${path}: ${stderr.trim() || `exit ${code}`}`);
  return { ok: true, path };
}
