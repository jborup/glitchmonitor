// SPDX-License-Identifier: AGPL-3.0-or-later

// The controls that choose what the timeline shows: preset spans, a custom
// span, stepping back and forth, and returning to the end. Used by the live
// dashboard and by the view of a saved run.

import { WINDOWS } from './timeline.js';
import { parseSpan, clampSpan, formatSpan, MIN_SPAN_SEC, MAX_SPAN_SEC } from './lib/savedrun.mjs';
import { formatClock } from './lib/format.mjs';

const $ = (sel) => document.querySelector(sel);

// wireRange connects the controls to a timeline and returns a function that
// refreshes the label. endName is what the end of the data is called: "now"
// while measuring, "the end of the run" for a saved run. wholeSpanSec, when
// given, adds a preset that shows the whole of a saved run.
export function wireRange(timeline, { endName, endButton, wholeSpanSec = null }) {
  const presets = $('#windows');
  const input = $('#span-text');
  const spans = WINDOWS.map((w) => ({ ...w }));
  if (wholeSpanSec) spans.unshift({ label: 'Whole run', sec: clampSpan(wholeSpanSec) });

  const refresh = () => {
    const v = timeline.view();
    for (const button of presets.children) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.sec) === v.spanSec));
    }
    $('#range-live').setAttribute('aria-pressed', String(v.following));
    $('#range-forward').disabled = v.following;
    const span = formatSpan(v.spanSec);
    $('#range-label').textContent = v.following
      ? `Showing the last ${span}, up to ${endName}. Drag across the chart to zoom in.`
      : `Showing ${formatClock(v.from * 1000)} to ${formatClock(v.to * 1000)} (${span}). `
        + `Press "${endButton}" to go back to ${endName}.`;
  };

  presets.replaceChildren(...spans.map((w) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: w.label });
    button.dataset.sec = w.sec;
    button.addEventListener('click', () => {
      timeline.setSpan(w.sec);
      refresh();
    });
    return button;
  }));

  $('#span-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const sec = parseSpan(input.value);
    const valid = sec != null && sec >= MIN_SPAN_SEC && sec <= MAX_SPAN_SEC;
    input.setCustomValidity(valid ? '' : `Give a span from ${formatSpan(MIN_SPAN_SEC)} to ${formatSpan(MAX_SPAN_SEC)}, such as 90s, 12m or 2h.`);
    input.reportValidity();
    if (!valid) return;
    timeline.setSpan(sec);
    input.value = '';
    refresh();
  });
  input.addEventListener('input', () => input.setCustomValidity(''));

  $('#range-back').addEventListener('click', () => { timeline.shift(-0.5); refresh(); });
  $('#range-forward').addEventListener('click', () => { timeline.shift(0.5); refresh(); });
  $('#range-live').textContent = endButton;
  $('#range-live').addEventListener('click', () => { timeline.follow(); refresh(); });
  refresh();
  return refresh;
}
