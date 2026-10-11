// SPDX-License-Identifier: AGPL-3.0-or-later

// The latency timeline (uPlot) and, on the same time axis below it, the strip
// that shows which nodes answered. uPlot is vendored and loaded as a global.

import {
  maxLatencyAt, failuresAt, allRecoveredAt, nodesAt, readSecond,
} from './lib/series.mjs';
import { formatClock } from './lib/format.mjs';
import { clampSpan } from './lib/savedrun.mjs';

export const HISTORY_SEC = 6 * 3600;
export const WINDOWS = [
  { label: '5 min', sec: 300 },
  { label: '30 min', sec: 1800 },
  { label: '3 h', sec: 3 * 3600 },
  { label: '6 h', sec: HISTORY_SEC },
];

const CHART_HEIGHT = 220;
const LANE = 10;      // css px
const LANE_GAP = 3;
const TARGET_HEAD = 20;
const MARKER_ROWS = 6;

// source: { targets(), log(), nodes(), now() }. A target is { name, color, series }.
// onViewChange is called when dragging across the chart changes what is shown.
export function createTimeline({ chartEl, stripEl, readoutEl, source, onViewChange }) {
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const ink = {
    text: color('--text'), muted: color('--muted'), grid: color('--border'), track: color('--track'),
    red: color('--red'), yellow: color('--yellow'), panel: color('--panel'),
  };

  // What is shown: spanSec seconds ending at `end` (epoch seconds), or ending
  // now and moving along with it while `end` is null.
  const view = { spanSec: WINDOWS[0].sec, end: null };
  let range = [0, 1];

  const axis = {
    stroke: ink.muted,
    grid: { stroke: ink.grid, width: 1 },
    ticks: { stroke: ink.grid, width: 1 },
    font: '11px system-ui, sans-serif',
  };
  const plot = new uPlot({
    width: chartEl.clientWidth,
    height: CHART_HEIGHT,
    scales: {
      x: { time: true, range: () => range },
      y: { range: (u, min, max) => [0, Math.max(50, (max || 0) * 1.15)] },
    },
    series: [
      { value: (u, v) => (v == null ? '–' : formatClock(v * 1000)) },
      ...source.targets().map((t) => ({
        label: t.name,
        stroke: t.color,
        width: 2,
        value: (u, v) => (v == null ? '–' : `${v.toFixed(0)} ms`),
      })),
    ],
    axes: [{ ...axis, values: clockTicks }, { ...axis, size: 56, values: (u, ticks) => ticks.map((v) => `${v} ms`) }],
    // Dragging across the chart selects a span to zoom in on.
    cursor: { drag: { x: true, y: false, setScale: false } },
    legend: { live: true },
    hooks: {
      drawClear: [drawBands],
      draw: [drawMarkers, drawStrip],
      setCursor: [showReadout],
      setSelect: [zoomToSelection],
    },
  }, [[0, 1], ...source.targets().map(() => [null, null])], chartEl);

  // Tick labels on the 24-hour clock the log uses; seconds only when the ticks are that fine.
  function clockTicks(u, ticks) {
    const seconds = ticks.some((t) => t % 60 !== 0);
    return ticks.map((t) => (seconds ? formatClock(t * 1000) : formatClock(t * 1000).slice(0, 5)));
  }

  new ResizeObserver(() => {
    if (chartEl.clientWidth > 0) plot.setSize({ width: chartEl.clientWidth, height: CHART_HEIGHT });
  }).observe(chartEl);

  function update() {
    const end = view.end ?? Math.floor(source.now() / 1000);
    const from = end - view.spanSec;
    const targets = source.targets();
    const xs = new Array(view.spanSec + 1);
    const ys = targets.map(() => new Array(view.spanSec + 1));
    for (let i = 0; i <= view.spanSec; i++) {
      const sec = from + i;
      xs[i] = sec;
      for (let k = 0; k < targets.length; k++) ys[k][i] = maxLatencyAt(targets[k].series, sec);
    }
    range = [from, end];
    plot.setData([xs, ...ys]);
  }

  function zoomToSelection(u) {
    const { left, width } = u.select;
    if (width < 4) return;
    const from = u.posToVal(left, 'x');
    const to = u.posToVal(left + width, 'x');
    u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    view.spanSec = clampSpan(to - from);
    view.end = Math.round(to);
    update();
    onViewChange?.();
  }

  function clipToPlot(u) {
    const { ctx, bbox } = u;
    ctx.save();
    ctx.beginPath();
    ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
    ctx.clip();
  }

  // Outages as red bands and measurement gaps as grey bands, behind the lines.
  // A band is at least 2 px wide, so a 100 ms blip still shows in the 6 h view.
  function drawBands(u) {
    const { ctx, bbox } = u;
    const [min, max] = range;
    const nowSec = source.now() / 1000;
    clipToPlot(u);
    for (const e of source.log()) {
      if (e.type !== 'outage' && e.type !== 'gap') continue;
      const start = e.start / 1000;
      const end = e.open ? nowSec : e.end / 1000;
      if (end < min || start > max) continue;
      const x0 = u.valToPos(Math.max(start, min), 'x', true);
      const x1 = u.valToPos(Math.min(end, max), 'x', true);
      ctx.fillStyle = e.type === 'outage' ? 'rgba(248, 81, 73, 0.30)' : 'rgba(139, 152, 165, 0.20)';
      ctx.fillRect(x0, bbox.top, Math.max(x1 - x0, 2 * devicePixelRatio), bbox.height);
    }
    ctx.restore();
  }

  // Markers as dashed lines with their text at the top. Texts that would run
  // into each other are put on the next row down, up to MARKER_ROWS rows.
  function drawMarkers(u) {
    const { ctx, bbox } = u;
    const [min, max] = range;
    const dpr = devicePixelRatio;
    clipToPlot(u);
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    const rowEnds = [];
    const markers = source.log()
      .filter((e) => e.type === 'marker' && e.start / 1000 >= min && e.start / 1000 <= max)
      .sort((a, b) => a.start - b.start);
    for (const e of markers) {
      const x = Math.round(u.valToPos(e.start / 1000, 'x', true));
      ctx.strokeStyle = ink.text;
      ctx.lineWidth = dpr;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(x, bbox.top);
      ctx.lineTo(x, bbox.top + bbox.height);
      ctx.stroke();
      ctx.setLineDash([]);
      const width = ctx.measureText(e.text).width;
      const left = x + 4 * dpr + width > bbox.left + bbox.width;
      const from = left ? x - 4 * dpr - width : x + 4 * dpr;
      let row = rowEnds.findIndex((end) => end + 8 * dpr < from);
      if (row < 0) row = rowEnds.length < MARKER_ROWS ? rowEnds.length : rowEnds.indexOf(Math.min(...rowEnds));
      rowEnds[row] = from + width;
      const y = bbox.top + (3 + row * 14) * dpr;
      // A backing in the panel colour keeps the text readable over lines and bands.
      ctx.fillStyle = ink.panel;
      ctx.globalAlpha = 0.75;
      ctx.fillRect(from - 2 * dpr, y - dpr, width + 4 * dpr, 13 * dpr);
      ctx.globalAlpha = 1;
      ctx.fillStyle = ink.text;
      ctx.textAlign = 'left';
      ctx.fillText(e.text, from, y);
    }
    ctx.restore();
  }

  // The strip: per target a "failed" lane and one lane per node, filled where
  // that node answered in that second. It shares the chart's x axis.
  function drawStrip(u) {
    const dpr = devicePixelRatio;
    const targets = source.targets();
    const nodes = source.nodes().map((name, bit) => ({ name, bit })).sort((a, b) => a.name.localeCompare(b.name));
    const lanes = nodes.length + 1;
    const blockHeight = TARGET_HEAD + lanes * (LANE + LANE_GAP);
    const height = Math.max(1, targets.length * blockHeight);

    stripEl.style.height = `${height}px`;
    stripEl.width = u.ctx.canvas.width;
    stripEl.height = Math.round(height * dpr);
    const ctx = stripEl.getContext('2d');
    const left = u.bbox.left;
    const width = u.bbox.width;
    const [min, max] = range;
    const xOf = (sec) => Math.min(left + width, Math.max(left, u.valToPos(sec, 'x', true)));

    const lane = (y, label, fill, minWidth, has, track = true) => {
      if (track) {
        ctx.fillStyle = ink.muted;
        ctx.textAlign = 'right';
        ctx.fillText(label, left - 6 * dpr, y + (LANE / 2) * dpr, left - 8 * dpr);
        ctx.fillStyle = ink.track;
        ctx.fillRect(left, y, width, LANE * dpr);
      }
      ctx.fillStyle = fill;
      let runStart = null;
      for (let sec = min; sec <= max + 1; sec++) {
        const on = sec <= max && has(sec);
        if (on && runStart == null) runStart = sec;
        if (!on && runStart != null) {
          const x0 = xOf(runStart);
          ctx.fillRect(x0, y, Math.max(xOf(sec) - x0, minWidth * dpr), LANE * dpr);
          runStart = null;
        }
      }
    };

    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    targets.forEach((t, k) => {
      let y = k * blockHeight * dpr;
      ctx.fillStyle = t.color;
      ctx.fillRect(left, y + 9 * dpr, 14 * dpr, 2 * dpr);
      ctx.fillStyle = ink.text;
      ctx.textAlign = 'left';
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      ctx.fillText(t.name, left + 20 * dpr, y + 10 * dpr);
      ctx.font = `${10 * dpr}px system-ui, sans-serif`;
      y += TARGET_HEAD * dpr;
      // Yellow where every failed request of that second was answered on a retry, red where not.
      lane(y, 'failed', ink.yellow, 2, (sec) => allRecoveredAt(t.series, sec));
      lane(y, '', ink.red, 2, (sec) => failuresAt(t.series, sec) > 0 && !allRecoveredAt(t.series, sec), false);
      for (const node of nodes) {
        y += (LANE + LANE_GAP) * dpr;
        lane(y, node.name, t.color, 1, (sec) => (nodesAt(t.series, sec) >>> node.bit) & 1);
      }
    });
  }

  // One line under the strip for the second under the cursor: every target,
  // how many answers, from which nodes, and how many failed.
  function showReadout(u) {
    const idx = u.cursor.idx;
    if (idx == null || u.cursor.left < 0) {
      readoutEl.textContent = 'Point at the chart to see who answered in that second.';
      return;
    }
    const sec = u.data[0][idx];
    const nodes = source.nodes();
    const parts = source.targets().map((t) => {
      const r = readSecond(t.series, sec);
      if (!r) return `${t.name}: no data`;
      const names = nodes.filter((_, bit) => (r.nodes >>> bit) & 1).sort();
      const from = names.length ? ` from ${names.join(', ')}` : '';
      const retried = r.failures && r.recovered ? ` (${r.recovered} fine on a retry)` : '';
      const failed = r.failures ? `, ${r.failures} failed${retried}` : '';
      return `${t.name}: ${r.answers} answered${from}${failed}`;
    });
    readoutEl.textContent = `${formatClock(sec * 1000)} · ${parts.join(' · ')}`;
  }

  showReadout(plot);
  return {
    update,
    // The span and the time range now shown: { spanSec, from, to, following }.
    view() {
      return { spanSec: view.spanSec, from: range[0], to: range[1], following: view.end == null };
    },
    setSpan(sec) {
      view.spanSec = clampSpan(sec);
      update();
    },
    // shift moves the view by a fraction of its span; reaching the present follows it again.
    shift(fraction) {
      const nowSec = Math.floor(source.now() / 1000);
      const end = (view.end ?? nowSec) + Math.round(view.spanSec * fraction);
      view.end = end >= nowSec ? null : end;
      update();
    },
    follow() {
      view.end = null;
      update();
    },
  };
}
