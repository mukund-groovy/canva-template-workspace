// Drive the debug Chrome (9222): open/reload the dashboard, read rendered pills + scores.
const http = require('http');
const path = require('path');
const { createRequire } = require('module');
const req = createRequire(__filename);
let WebSocket;
for (const p of [
  'ws',
  path.resolve(process.cwd(), 'node_modules/.pnpm/ws@8.18.3/node_modules/ws'),
  path.resolve(process.cwd(), 'node_modules/.pnpm/ws@8.19.0/node_modules/ws'),
  path.resolve(process.cwd(), 'node_modules/.pnpm/ws@8.17.1/node_modules/ws'),
]) { try { WebSocket = req(p); break; } catch {} }
if (!WebSocket) { console.error('ws module not found'); process.exit(1); }

const dashUrl = 'file:///' + path.resolve(process.cwd(), 'canva-template-workspace/dashboard.html').replace(/\\/g, '/');
const getJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

(async () => {
  const list = (await getJSON('http://localhost:9222/json/list')).filter(t => t.type === 'page');
  // prefer an already-open dashboard tab, else any page tab
  let target = list.find(t => (t.url || '').includes('dashboard.html')) || list[0];
  if (!target) { console.error('no page tab'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = {};
  const send = (method, params) => new Promise((res) => { const i = ++id; pending[i] = res; ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  ws.on('message', (m) => { const o = JSON.parse(m); if (o.id && pending[o.id]) { pending[o.id](o.result); delete pending[o.id]; } });
  await new Promise(r => ws.on('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  // hard navigate (cache-bypass) to the current dashboard file
  await send('Page.navigate', { url: dashUrl });
  await new Promise(r => setTimeout(r, 2500));
  const expr = `JSON.stringify({
    legend: [...document.querySelectorAll('.pipeline .pstep')].map(x=>x.textContent),
    rows: [...document.querySelectorAll('#tbody tr')].map(tr => ({
      name: (tr.querySelector('.tt')||{}).textContent || '',
      pill: (tr.querySelector('.pill')||{}).textContent || '',
      score: (tr.querySelector('.score')||{textContent:'—'}).textContent || '—',
      tmplBtn: !!tr.querySelector('a.btn[href*="carousels"]')
    }))
  })`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const data = JSON.parse(r.result.value);
  console.log('legend:', data.legend.join('  '));
  console.log('rows rendered:', data.rows.length);
  for (const row of data.rows) console.log('  ' + row.pill.padEnd(16) + ' ' + row.score.padEnd(8) + ' tmplBtn=' + (row.tmplBtn ? 'y' : 'n') + '  ' + row.name.slice(0, 28));
  ws.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
