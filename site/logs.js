// =============================================================================
// logs.js — the Logs tab: in-memory timings (perflog.js), newest first
// =============================================================================
// Re-rendered on new events while the tab is visible (throttled to one render per animation
// frame). index.html calls renderLogs() when the tab is opened.
// =============================================================================

import { perf, BUILD } from './perflog.js?v=__BUILD__';

const _pageStart = performance.timeOrigin;
let _logsFrame = 0;

export function renderLogs() {
  _logsFrame = 0;
  if (document.getElementById('view-logs').style.display === 'none') return;
  const ev = perf.events;
  const sum = (k) => ev.filter(e => e.kind === k);
  const http = sum('http'), reads = http.filter(e => e.range);
  const ms = (a) => a.reduce((s, e) => s + (e.ms || 0), 0);
  const kb = (a) => a.reduce((s, e) => s + (e.bytes || 0), 0) / 1024;
  const pct = (a, p) => { const v = a.map(e => e.ms).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0; };
  document.getElementById('logsSummary').textContent = [
    `build         : ${BUILD}`,
    `HTTP requests : ${http.length}  (Range reads/seeks: ${reads.length})   ${(kb(http) / 1024).toFixed(1)} MB`,
    `seek latency  : avg ${(ms(reads) / (reads.length || 1)).toFixed(0)} ms   p50 ${pct(reads, 0.5).toFixed(0)} ms   p95 ${pct(reads, 0.95).toFixed(0)} ms   max ${pct(reads, 1).toFixed(0)} ms   sum ${(ms(reads) / 1000).toFixed(1)} s`,
    `SAS calls     : ${sum('sas').length}  (${ms(sum('sas')).toFixed(0)} ms)    ATTACH: ${ms(sum('attach')).toFixed(0)} ms    queries: ${sum('query').length}  (${(ms(sum('query')) / 1000).toFixed(1)} s)`,
  ].join('\n');
  const esc = (t) => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  document.querySelector('#logsTable tbody').innerHTML = ev.slice().reverse().map(e =>
    `<tr><td>${((e.at - _pageStart) / 1000).toFixed(2)}</td><td>${e.kind}</td><td>${esc(e.what)}</td>` +
    `<td>${esc(e.range || '')}</td><td>${esc(e.status ?? '')}</td>` +
    `<td>${e.bytes == null ? '' : (e.bytes / 1024).toFixed(0)}</td><td>${e.ms == null ? '' : e.ms.toFixed(0)}</td></tr>`).join('');
}

perf.onChange(() => { _logsFrame ||= requestAnimationFrame(renderLogs); });
document.getElementById('logsClear').onclick = () => perf.clear();
// Copy: summary + table as TSV (pastes cleanly into chat or a spreadsheet).
document.getElementById('logsCopy').onclick = async (e) => {
  const rows = [...document.querySelectorAll('#logsTable tr')].map(tr => [...tr.cells].map(c => c.textContent).join('\t'));
  const text = document.getElementById('logsSummary').textContent + '\n' + rows.join('\n');
  const btn = e.currentTarget;
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
  catch {
    // Fabric iframe may deny the Clipboard API — fall back to a selected textarea + execCommand.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    btn.textContent = document.execCommand('copy') ? 'Copied' : 'Copy failed';
    ta.remove();
  }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
};
