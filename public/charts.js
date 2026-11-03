const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((s) => s * magnitude >= value);
  return step * magnitude;
}

/**
 * Time-series line chart with a crosshair tooltip. One shared y scale.
 * series: [{ key, label, color }], options: { height, max, format, ariaLabel }
 */
export class LineChart {
  constructor({ series, height = 120, max = null, format = String, ariaLabel = '' }) {
    Object.assign(this, { series, height, max, format });
    this.points = [];
    this.hoverX = null;
    this.el = document.createElement('div');
    this.el.className = 'chart';
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', ariaLabel);
    if (series.length > 1) {
      const legend = document.createElement('div');
      legend.className = 'legend';
      for (const s of series) {
        const item = document.createElement('span');
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = s.color;
        item.append(swatch, s.label);
        legend.append(item);
      }
      this.el.append(legend);
    }
    this.plot = document.createElement('div');
    this.plot.style.position = 'relative';
    this.el.append(this.plot);
    this.plot.addEventListener('pointermove', (e) => {
      this.hoverX = e.clientX - this.plot.getBoundingClientRect().left;
      this.render();
    });
    this.plot.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.render();
    });
    this.resize = new ResizeObserver(() => this.render());
    this.resize.observe(this.plot);
  }

  update(history) {
    this.points = history;
    this.render();
  }

  destroy() {
    this.resize.disconnect();
  }

  render() {
    const width = this.plot.clientWidth;
    if (!width) return;
    const values = this.points.flatMap((p) => this.series.map((s) => p[s.key])).filter((v) => v !== null && v !== undefined);
    if (this.points.length < 2 || !values.length) {
      const empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = 'Collecting samples';
      this.plot.replaceChildren(empty);
      return;
    }

    const margin = { left: 44, right: 6, top: 6, bottom: 18 };
    const innerW = Math.max(10, width - margin.left - margin.right);
    const innerH = this.height - margin.top - margin.bottom;
    const yMax = this.max ?? niceMax(Math.max(...values));
    const tStart = this.points[0].t;
    const tEnd = this.points.at(-1).t;
    const x = (t) => margin.left + ((t - tStart) / Math.max(1, tEnd - tStart)) * innerW;
    const y = (v) => margin.top + innerH - (Math.min(v, yMax) / yMax) * innerH;

    const root = svg('svg', { viewBox: `0 0 ${width} ${this.height}`, height: this.height });
    for (const tick of [0, 0.5, 1]) {
      const value = yMax * tick;
      root.append(svg('line', {
        x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value),
        class: tick === 0 ? 'chart-base' : 'chart-grid',
      }));
      root.append(svg('text', { x: margin.left - 6, y: y(value) + 4, 'text-anchor': 'end', class: 'chart-tick' }, this.format(value)));
    }
    const minutes = Math.round((tEnd - tStart) / 6000) / 10;
    root.append(svg('text', { x: margin.left, y: this.height - 4, class: 'chart-tick' }, `${minutes} min ago`));
    root.append(svg('text', { x: width - margin.right, y: this.height - 4, 'text-anchor': 'end', class: 'chart-tick' }, 'now'));

    for (const s of this.series) {
      let d = '';
      let open = false;
      for (const p of this.points) {
        const v = p[s.key];
        if (v === null || v === undefined) {
          open = false;
          continue;
        }
        d += `${open ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(v).toFixed(1)}`;
        open = true;
      }
      root.append(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }

    const children = [root];
    if (this.hoverX !== null && this.hoverX >= margin.left) {
      const targetT = tStart + ((this.hoverX - margin.left) / innerW) * (tEnd - tStart);
      const point = this.points.reduce((best, p) => (Math.abs(p.t - targetT) < Math.abs(best.t - targetT) ? p : best));
      root.append(svg('line', { x1: x(point.t), x2: x(point.t), y1: margin.top, y2: margin.top + innerH, class: 'chart-cross' }));
      for (const s of this.series) {
        const v = point[s.key];
        if (v !== null && v !== undefined) {
          root.append(svg('circle', { cx: x(point.t), cy: y(v), r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
        }
      }
      const tip = document.createElement('div');
      tip.className = 'chart-tip';
      const time = document.createElement('div');
      time.className = 'muted';
      time.textContent = new Date(point.t).toLocaleTimeString();
      tip.append(time);
      for (const s of this.series) {
        const line = document.createElement('div');
        const v = point[s.key];
        line.textContent = `${s.label}: ${v === null || v === undefined ? 'n/a' : this.format(v)}`;
        tip.append(line);
      }
      if (x(point.t) > width / 2) tip.style.right = `${width - x(point.t) + 10}px`;
      else tip.style.left = `${x(point.t) + 10}px`;
      children.push(tip);
    }
    this.plot.replaceChildren(...children);
  }
}
