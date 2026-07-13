#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const VALID_STATUSES = new Set([
  'pending',
  'cloning',
  'cloned',
  'generating',
  'success',
  'failed',
  'duplicate',
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[k] = v;
  }
  return out;
}

function toIsoNow() {
  return new Date().toISOString();
}

function durationMs(startedAt, finishedAt) {
  const s = Date.parse(String(startedAt || ''));
  const f = Date.parse(String(finishedAt || ''));
  if (!Number.isFinite(s) || !Number.isFinite(f) || f < s) return null;
  return f - s;
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'queued') return 'pending';
  if (s === 'running') return 'generating';
  return VALID_STATUSES.has(s) ? s : 'pending';
}

function parseDesignIdFromUrl(url) {
  const m = String(url || '').match(/\/design\/([^/?#]+)/i);
  return m ? m[1] : null;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runNode(scriptPath, args, cwd) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: res.status ?? 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
  };
}

function parseJsonOutput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function copyFileSafe(sourcePath, targetPath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function writeCloneWorkspaceSummary({ workspaceRoot, designId, cloneProfile, cloneJson, inputHtml, entry }) {
  const designRoot = path.join(workspaceRoot, 'designs', designId);
  const extractDir = path.join(designRoot, 'extract');
  const pagesDir = path.join(extractDir, 'assets', 'pages');
  const summaryPath = path.join(designRoot, 'workspace-summary.json');
  const summary = {
    designId,
    startedAt: entry?.startedAt || toIsoNow(),
    finishedAt: toIsoNow(),
    workspaceRoot,
    cloneProfile,
    clone: cloneJson || null,
    quality: {
      targetRmse: null,
      stopOnTarget: null,
      gate: null,
    },
    runTracking: {
      runId: null,
      runDir: null,
      report: null,
      output: null,
      createdAt: toIsoNow(),
      source: 'clone-only',
      duplicate: Boolean(cloneJson?.duplicate),
    },
    final: {
      duplicate: Boolean(cloneJson?.duplicate),
      output: null,
      duplicateOf: cloneJson?.duplicateOf || null,
    },
    paths: {
      inputHtml: inputHtml || null,
      extractDir,
      pagesDir,
    },
  };
  writeJson(summaryPath, summary);
  return summaryPath;
}

function writeCloneCover(workspaceRoot, designId) {
  const designRoot = path.join(workspaceRoot, 'designs', designId);
  const pagesDir = path.join(designRoot, 'extract', 'assets', 'pages');
  const coverPath = path.join(designRoot, 'archetype-cover.png');
  const source = firstExisting([
    path.join(pagesDir, 'page-01-actual.png'),
    path.join(pagesDir, 'page-01-preview.png'),
    path.join(pagesDir, 'page-01-thumbnail.png'),
  ]);
  if (!source) {
    if (fs.existsSync(coverPath)) fs.rmSync(coverPath, { force: true });
    return null;
  }
  const copied = copyFileSafe(source, coverPath);
  return copied ? coverPath : null;
}

function statusCounts(entries) {
  const base = {
    pending: 0,
    cloning: 0,
    cloned: 0,
    generating: 0,
    success: 0,
    failed: 0,
    duplicate: 0,
  };
  for (const e of Array.isArray(entries) ? entries : []) {
    const k = normalizeStatus(e?.status);
    if (Object.prototype.hasOwnProperty.call(base, k)) base[k] += 1;
  }
  return base;
}

function renderDashboardHtml(store) {
  const safeJson = JSON.stringify(store).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Template Studio · Dashboard</title>
  <style>
    :root{
      --ink:#eef1f6;--muted:#9aa4b2;--faint:#6b7482;
      --card:rgba(255,255,255,.045);--brd:rgba(255,255,255,.09);--accent:#7c9cff;
    }
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;color:var(--ink);
      background:radial-gradient(1200px 620px at 12% -12%,#1a2440 0%,transparent 58%),radial-gradient(1000px 520px at 112% 8%,#2a1a44 0%,transparent 55%),#0b0e14;
      font:14px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
    .wrap{max-width:1340px;margin:0 auto;padding:36px 24px 90px}
    .head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:22px}
    .title{font-size:31px;font-weight:800;letter-spacing:-.02em;margin:0;
      background:linear-gradient(92deg,#fff,#b9c6ff 90%);-webkit-background-clip:text;background-clip:text;color:transparent}
    .sub{color:var(--muted);font-size:14px;margin-top:4px}
    .upd{color:var(--faint);font-size:12.5px;text-align:right;line-height:1.7}
    .upd b{color:var(--ink);font-weight:700}
    .stats{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:28px}
    .stat{display:flex;align-items:center;gap:9px;padding:9px 15px;border-radius:12px;background:var(--card);border:1px solid var(--brd);backdrop-filter:blur(8px)}
    .stat .dot{width:9px;height:9px;border-radius:50%}
    .stat .n{font-weight:800;font-size:16px}
    .stat .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.07em}
    .toolbar{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:16px}
    .pipeline{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin:2px 0 16px;padding:10px 13px;border:1px solid var(--brd);border-radius:11px;background:var(--card)}
    .pipeline .plabel{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin-right:4px}
    .pipeline .pstep{font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;border:1px solid var(--brd)}
    .pipeline .pstep.s0{color:#8a94a3}.pipeline .pstep.s1{color:#f4c66b;border-color:rgba(244,198,107,.3)}.pipeline .pstep.s2{color:#83e6ac;border-color:rgba(131,230,172,.3)}
    .pipeline .parr{color:var(--faint);font-weight:700}
    .pipeline .pnote{flex-basis:100%;font-size:11.5px;color:var(--faint);margin-top:3px}
    .filters{display:flex;flex-wrap:wrap;gap:8px}
    .fchip{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:10px;background:var(--card);border:1px solid var(--brd);color:var(--muted);font-size:12.5px;font-weight:600;cursor:pointer;transition:.12s}
    .fchip:hover{border-color:rgba(124,156,255,.45);color:var(--ink)}
    .fchip.active{background:rgba(124,156,255,.16);border-color:rgba(124,156,255,.6);color:#fff}
    .fchip .dot{width:8px;height:8px;border-radius:50%}
    .fchip .c{font-weight:800}
    .search{background:var(--card);border:1px solid var(--brd);border-radius:10px;color:var(--ink);padding:9px 13px;font-size:13px;min-width:230px;outline:none}
    .search:focus{border-color:rgba(124,156,255,.6)}
    .search::placeholder{color:var(--faint)}
    .tablewrap{background:var(--card);border:1px solid var(--brd);border-radius:16px;overflow:auto;backdrop-filter:blur(10px)}
    table{width:100%;border-collapse:collapse;min-width:940px}
    thead th{position:sticky;top:0;background:#12151d;color:var(--faint);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;text-align:left;padding:13px 14px;border-bottom:1px solid var(--brd);z-index:1}
    tbody td{padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.055);vertical-align:middle}
    tbody tr:last-child td{border-bottom:none}
    tbody tr:hover{background:rgba(124,156,255,.06)}
    .thumb{width:46px;height:58px;border-radius:8px;object-fit:cover;display:block;border:1px solid var(--brd);cursor:pointer;background:#0d1017;transition:.12s}
    .thumb:hover{border-color:var(--accent);transform:scale(1.05)}
    .tt{font-weight:700;font-size:13.5px;line-height:1.3;max-width:280px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .id{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--faint);margin-top:2px}
    .pill{display:inline-flex;align-items:center;padding:4px 11px;border-radius:999px;font-size:11.5px;font-weight:700;text-transform:capitalize;color:#0b0e14}
    .meta{display:flex;flex-direction:column;gap:5px}
    .mrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
    .chip{font-size:11px;color:var(--muted);background:rgba(255,255,255,.05);border:1px solid var(--brd);padding:2px 8px;border-radius:7px;white-space:nowrap}
    .chip b{color:var(--ink)}
    .chip.bad{color:#ff9b9b;border-color:rgba(255,107,107,.28);background:rgba(255,107,107,.09)}
    .sw{width:14px;height:14px;border-radius:4px;border:1px solid rgba(255,255,255,.55)}
    .score{font-size:12.5px;font-weight:700;white-space:nowrap}
    .score.ok{color:#83e6ac}.score.mid{color:#f4c66b}.score.bad{color:#ff9b9b}.score .p{color:var(--faint);font-weight:500}
    .files{display:flex;flex-wrap:wrap;gap:6px}
    .btn{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;text-decoration:none;padding:6px 11px;border-radius:8px;border:1px solid var(--brd);color:var(--ink);background:rgba(255,255,255,.04);cursor:pointer;white-space:nowrap;transition:.12s}
    .btn:hover{background:rgba(124,156,255,.16);border-color:rgba(124,156,255,.5)}
    .btn.primary{background:linear-gradient(92deg,#5b78ff,#7c9cff);border-color:transparent;color:#0b0e14;font-weight:700}
    .btn.ghost{color:var(--muted)}
    .when{color:var(--faint);font-size:12px;white-space:nowrap}.when b{color:var(--ink);font-weight:600}
    .empty{padding:56px;text-align:center;color:var(--muted)}
    .modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:26px}
    .modal[hidden]{display:none}
    .mbg{position:absolute;inset:0;background:rgba(6,8,12,.72);backdrop-filter:blur(4px)}
    .mbox{position:relative;width:min(1180px,94vw);height:min(90vh,1000px);background:#0e121a;border:1px solid var(--brd);border-radius:16px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 30px 90px rgba(0,0,0,.6)}
    .mhead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--brd);background:#12151d}
    .mtitle{font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mtitle span{color:var(--faint);font-weight:400;font-size:12px;margin-left:8px}
    .mclose{border:1px solid var(--brd);background:rgba(255,255,255,.05);color:var(--ink);border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:15px;flex:none}
    .mclose:hover{background:rgba(255,107,107,.18);border-color:rgba(255,107,107,.5)}
    .mframe{flex:1;border:0;width:100%;background:#0b0e14}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <div>
        <h1 class="title">Template Studio</h1>
        <div class="sub">Every Canva design → its exact replica → your brand-recolorable variant.</div>
      </div>
      <div class="upd" id="upd"></div>
    </div>
    <div class="pipeline">
      <span class="plabel">Pipeline</span>
      <span class="pstep s0">0 · Queued</span><span class="parr">→</span>
      <span class="pstep s1">1 · Cloning…</span><span class="parr">→</span>
      <span class="pstep s1">1 · Cloned</span><span class="parr">→</span>
      <span class="pstep s2">2 · Generating…</span><span class="parr">→</span>
      <span class="pstep s2">2 · Ready</span>
      <span class="pnote">Stage 1 = clone intake (thumbnails + data) · Stage 2 = author brand-recolorable template + score /10</span>
    </div>
    <div class="toolbar">
      <div class="filters" id="filters"></div>
      <input class="search" id="search" type="search" placeholder="Search design id or title…" />
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Preview</th><th>Template</th><th>Status</th><th>Details</th><th>Score</th><th>Files</th><th>Updated</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table></div>
    <div class="empty" id="empty" hidden>No templates match your filter.</div>
  </div>
  <div class="modal" id="modal" hidden>
    <div class="mbg" data-close></div>
    <div class="mbox">
      <div class="mhead"><div class="mtitle" id="mtitle"></div><button class="mclose" id="mclose" title="Close (Esc)">✕</button></div>
      <iframe class="mframe" id="mframe" src="about:blank"></iframe>
    </div>
  </div>
  <script>
    const STORE = ${safeJson};
    const VALID = new Set(${JSON.stringify([...VALID_STATUSES])});
    const counts = ${JSON.stringify(statusCounts(store?.entries))};
    const SC = {pending:'#8a94a3',cloning:'#5b9bff',cloned:'#3fb6d8',generating:'#37b877',success:'#43c47a',failed:'#ff6b6b',duplicate:'#e0a53a'};
    function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
    function normalizeStatus(s){const k=String(s||'').toLowerCase(); if(k==='queued') return 'pending'; if(k==='running') return 'generating'; return VALID.has(k)?k:'pending';}
    function fmtDate(s){if(!s) return '-'; const d=new Date(s); if(Number.isNaN(d.getTime())) return esc(s); return d.toLocaleString();}
    function fmtMs(ms){if(!(Number.isFinite(ms)&&ms>=0)) return '-'; if(ms<1000) return ms+' ms'; const sec=Math.round(ms/1000); if(sec<60) return sec+' s'; const m=Math.floor(sec/60); return m+'m '+(sec%60)+'s';}
    function fileHref(p){if(!p) return ''; return 'file:///'+String(p).replace(/\\\\/g,'/');}
    const entries = (Array.isArray(STORE.entries)?STORE.entries.slice():[]).sort((a,b)=>String(b.createdAt||b.updatedAt||'').localeCompare(String(a.createdAt||a.updatedAt||'')));
    document.getElementById('upd').innerHTML='<b>'+entries.length+'</b> template'+(entries.length===1?'':'s')+'<br>Updated '+(STORE.generatedAt?new Date(STORE.generatedAt).toLocaleString():'-');

    // ---- modal (in-page iframe preview; no new tabs) ----
    const modal=document.getElementById('modal'),mframe=document.getElementById('mframe'),mtitle=document.getElementById('mtitle');
    function openModal(href,title,sub){ if(!href) return; mframe.src=href; mtitle.innerHTML=esc(title)+(sub?'<span>'+esc(sub)+'</span>':''); modal.hidden=false; document.body.style.overflow='hidden'; }
    function closeModal(){ modal.hidden=true; mframe.src='about:blank'; document.body.style.overflow=''; }
    document.getElementById('mclose').onclick=closeModal;
    modal.querySelector('[data-close]').onclick=closeModal;
    document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeModal(); });
    document.addEventListener('click',e=>{ const t=e.target.closest('[data-modal]'); if(t){ e.preventDefault(); openModal(t.getAttribute('data-href'),t.getAttribute('data-title'),t.getAttribute('data-sub')||''); }});

    // ---- filters (status chips + search) ----
    let activeFilter='all', term='';
    const order=[['all','All'],['success','Success'],['generating','Generating'],['cloned','Cloned'],['cloning','Cloning'],['pending','Pending'],['failed','Failed'],['duplicate','Duplicate']];
    document.getElementById('filters').innerHTML=order.map(([k,l])=>{
      const n=k==='all'?entries.length:(counts[k]||0);
      const dot=k==='all'?'':'<span class="dot" style="background:'+(SC[k]||'#888')+'"></span>';
      return '<button class="fchip'+(k==='all'?' active':'')+'" data-f="'+k+'">'+dot+esc(l)+' <span class="c">'+n+'</span></button>';
    }).join('');
    document.getElementById('filters').addEventListener('click',e=>{ const b=e.target.closest('[data-f]'); if(!b) return; activeFilter=b.getAttribute('data-f'); [...document.querySelectorAll('.fchip')].forEach(x=>x.classList.toggle('active',x===b)); apply(); });
    document.getElementById('search').addEventListener('input',e=>{ term=e.target.value.toLowerCase().trim(); apply(); });

    // ---- rows ----
    function fileBtn(cls,label,p){ return p?'<button class="btn '+cls+'" data-modal data-href="'+esc(fileHref(p))+'" data-title="'+esc(label)+'" data-sub="'+esc(p)+'" title="'+esc(p)+'">'+label+'</button>':''; }
    function row(e){
      const st=normalizeStatus(e.status),c=SC[st]||'#8a94a3',m=e.meta||{},gate=e.qualityGate||{};
      const rmse=(m.rmse!=null)?Number(m.rmse).toFixed(3):null,met=gate.met;
      const preview=e.comparison||e.thumb;
      const thumb=e.thumb?'<img class="thumb" src="'+esc(fileHref(e.thumb))+'" data-modal data-href="'+esc(fileHref(preview))+'" data-title="'+esc(m.title||e.designId||'Preview')+'" data-sub="Original → replica → variant" title="Open preview" alt=""/>':'';
      const pal=(Array.isArray(m.palette)?m.palette:[]).slice(0,5).map(x=>'<span class="sw" style="background:'+esc(x)+'"></span>').join('');
      const details='<div class="meta"><div class="mrow">'+(m.pages?'<span class="chip"><b>'+m.pages+'</b> slides</span>':'')+(Array.isArray(m.fonts)&&m.fonts.length?'<span class="chip">'+m.fonts.slice(0,2).map(esc).join(' · ')+'</span>':'')+'</div>'+(pal?'<div class="mrow">'+pal+'</div>':'')+'</div>';
      const sc=(m.score!=null)?Number(m.score):null;
      const score=sc!=null?'<span class="score '+(sc>=8?'ok':sc>=5?'mid':'bad')+'" title="gate-derived quality score">'+sc+'<span class="p">/10</span></span>':'<span class="when">—</span>';
      const files='<div class="files">'+
        (e.comparison?'<button class="btn primary" data-modal data-href="'+esc(fileHref(e.comparison))+'" data-title="Comparison" data-sub="'+esc(e.designId)+'">Preview ↗</button>':'')+
        (e.archetype?'<a class="btn" href="'+esc(fileHref(e.archetype))+'" target="_blank" rel="noreferrer" title="Open the generated template HTML: '+esc(e.archetype)+'">Template ↗</a>':'')+
        fileBtn('ghost','Summary', e.summary)+
        (e.sourceUrl?'<a class="btn ghost" href="'+esc(e.sourceUrl)+'" target="_blank" rel="noreferrer" title="'+esc(e.sourceUrl)+'">Source ↗</a>':'')+
      '</div>';
      const err=e.lastError?'<span class="chip bad" title="'+esc(e.lastError)+'" style="margin-top:5px;display:inline-block">error</span>':'';
      return '<tr data-status="'+st+'" data-search="'+esc(((e.designId||'')+' '+(m.title||'')).toLowerCase())+'">'+
        '<td>'+thumb+'</td>'+
        '<td><div class="tt">'+esc(m.title||e.designId||'Untitled')+'</div><div class="id">'+esc(e.designId||'')+'</div>'+err+'</td>'+
        '<td><span class="pill" style="background:'+c+'" title="'+esc(st)+'">'+esc(({pending:'Queued',cloning:'Cloning…',cloned:'Cloned',generating:'Generating…',success:'Ready',failed:'✕ Failed',duplicate:'⧉ Duplicate'})[st]||st)+'</span></td>'+
        '<td>'+details+'</td>'+
        '<td>'+score+'</td>'+
        '<td>'+files+'</td>'+
        '<td class="when"><b>'+fmtDate(e.updatedAt)+'</b><br>'+fmtMs(e.durationMs)+'</td>'+
      '</tr>';
    }
    document.getElementById('tbody').innerHTML = entries.length?entries.map(row).join(''):'';
    function apply(){
      let shown=0;
      [...document.querySelectorAll('#tbody tr')].forEach(tr=>{
        const okS=activeFilter==='all'||tr.getAttribute('data-status')===activeFilter;
        const okT=!term||(tr.getAttribute('data-search')||'').includes(term);
        const vis=okS&&okT; tr.style.display=vis?'':'none'; if(vis) shown++;
      });
      document.getElementById('empty').hidden = shown>0 && entries.length>0;
      if(!entries.length){ document.getElementById('empty').hidden=false; document.getElementById('empty').textContent='No templates yet. Run a design to see it here.'; }
    }
    apply();
  </script>
</body>
</html>`;
}

// Enrich a dashboard entry with lightweight display metadata (title, slide count,
// fonts, palette, best RMSE) read from the extracted template + autotune report,
// plus a thumbnail path (archetype cover when available, else the original page-1
// reference). Cheap JSON reads; keeps renderDashboardHtml a pure function.
function enrichEntryMeta(workspaceRoot, entry) {
  if (!entry?.designId) return false;
  const designRoot = path.join(workspaceRoot, 'designs', String(entry.designId));
  const meta = { ...(entry.meta || {}) };

  const tdPath = path.join(designRoot, 'extract', 'template-data.json');
  if (fs.existsSync(tdPath)) {
    try {
      const d = JSON.parse(fs.readFileSync(tdPath, 'utf8'));
      const pages = Array.isArray(d.pages) ? d.pages : [];
      meta.title = d.title || '';
      meta.pages = pages.length;
      meta.fonts = [
        ...new Set((Array.isArray(d.fonts) ? d.fonts : []).map((f) => f?.C).filter(Boolean)),
      ].slice(0, 3);
      const colors = new Set();
      const bg0 = pages[0]?.D?.C;
      if (bg0) colors.add(String(bg0).toLowerCase());
      for (const pg of pages) {
        for (const el of Array.isArray(pg.E) ? pg.E : []) {
          if (el['A?'] === 'K') {
            for (const r of Array.isArray(el?.a?.B) ? el.a.B : []) {
              const c = r?.A?.color?.B;
              if (c) colors.add(String(c).toLowerCase());
            }
          }
          if (el['A?'] === 'J') {
            const c = (Array.isArray(el.b) ? el.b[0] : {})?.B?.C;
            if (c) colors.add(String(c).toLowerCase());
          }
        }
      }
      meta.palette = [...colors].filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 6);
    } catch {
      // malformed template-data — leave prior meta.
    }
  }

  const repPath = path.join(designRoot, 'extract', 'template-clone-pure-html-autotune-report.json');
  if (fs.existsSync(repPath)) {
    try {
      const r = JSON.parse(fs.readFileSync(repPath, 'utf8'));
      if (r?.best?.avgRmse != null) meta.rmse = Number(r.best.avgRmse);
      if (Array.isArray(r?.references)) meta.scoredPages = r.references.length;
    } catch {
      // ignore report parse errors.
    }
  }

  let changed = false;
  if (JSON.stringify(entry.meta) !== JSON.stringify(meta)) {
    entry.meta = meta;
    changed = true;
  }

  const archCover = path.join(designRoot, 'archetype-cover.png');
  const origThumb = path.join(designRoot, 'extract', 'assets', 'pages', 'page-01-preview.png');
  const thumb = fs.existsSync(archCover) ? archCover : fs.existsSync(origThumb) ? origThumb : null;
  if (thumb && entry.thumb !== thumb) {
    entry.thumb = thumb;
    changed = true;
  }
  return changed;
}

function saveDashboard(workspaceRoot, store) {
  const normalized = {
    version: 1,
    generatedAt: toIsoNow(),
    entries: Array.isArray(store?.entries) ? store.entries : [],
  };
  for (const e of normalized.entries) {
    e.status = normalizeStatus(e.status);
  }
  const storePath = path.join(workspaceRoot, 'dashboard-store.json');
  const htmlPath = path.join(workspaceRoot, 'dashboard.html');
  writeJson(storePath, normalized);
  fs.writeFileSync(htmlPath, renderDashboardHtml(normalized), 'utf8');
  return { storePath, htmlPath, store: normalized };
}

function upsertEntry(entries, designId) {
  const list = Array.isArray(entries) ? entries : [];
  let entry = list.find((x) => String(x?.designId || '') === String(designId || ''));
  if (!entry) {
    entry = {
      designId,
      status: 'pending',
      createdAt: toIsoNow(),
      updatedAt: toIsoNow(),
      attempts: 0,
    };
    list.push(entry);
  }
  entry.status = normalizeStatus(entry.status);
  return { list, entry };
}

function reconcileEntryFromWorkspace(workspaceRoot, entry) {
  if (!entry || !entry.designId) return false;
  const designRoot = path.join(workspaceRoot, 'designs', String(entry.designId));
  const extractDir = path.join(designRoot, 'extract');
  const finalDir = path.join(designRoot, 'final');
  const summaryPath = path.join(designRoot, 'workspace-summary.json');
  const outputPath = path.join(finalDir, 'template-clone-pure-html.html');
  const duplicatePath = path.join(extractDir, 'duplicate-template.json');
  const extractTemplateData = path.join(extractDir, 'template-data.json');
  const mutableStatuses = new Set(['pending', 'cloning', 'cloned', 'generating']);
  const current = normalizeStatus(entry.status);
  const hasOutput = fs.existsSync(outputPath);
  const hasSummary = fs.existsSync(summaryPath);
  const hasDuplicateMeta = fs.existsSync(duplicatePath);
  const hasExtractTemplate = fs.existsSync(extractTemplateData);
  let changed = false;

  if (hasOutput) {
    if (mutableStatuses.has(current)) {
      entry.status = 'success';
      changed = true;
    }
    if (!entry.output) {
      entry.output = outputPath;
      changed = true;
    }
  }

  if (hasSummary) {
    if (!entry.summary) {
      entry.summary = summaryPath;
      changed = true;
    }
    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      if (!entry.output && summary?.final?.output) {
        entry.output = String(summary.final.output);
        changed = true;
      }
      if (!entry.qualityGate && summary?.quality?.gate) {
        entry.qualityGate = summary.quality.gate;
        changed = true;
      }
    } catch {
      // Ignore summary parse errors during reconciliation.
    }
  }

  if (!hasOutput && hasDuplicateMeta && mutableStatuses.has(current)) {
    entry.status = 'duplicate';
    changed = true;
  } else if (!hasOutput && hasExtractTemplate && current === 'pending') {
    entry.status = 'cloned';
    changed = true;
  }

  if (fs.existsSync(extractDir) && !entry.extractDir) {
    entry.extractDir = extractDir;
    changed = true;
  }
  const comparisonPath = path.join(designRoot, 'comparison.html');
  if (fs.existsSync(comparisonPath)) {
    if (entry.comparison !== comparisonPath) {
      entry.comparison = comparisonPath;
      changed = true;
    }
  }
  // Archetype (the actual deliverable) — resolved from archetype-map.json. The
  // pixel clone in entry.output is only the internal reference; when a design has
  // a mapped brand archetype, that HTML is what the dashboard should surface so
  // the "Template" column matches the archetype shown in the Comparison view.
  try {
    const mapPath = path.join(workspaceRoot, 'archetype-map.json');
    if (fs.existsSync(mapPath)) {
      const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      const slug = map && typeof map === 'object' ? map[entry.designId] : null;
      if (slug) {
        const tdir = fs.existsSync(path.join(workspaceRoot, 'output'))
          ? path.join(workspaceRoot, 'output')
          : path.resolve(workspaceRoot, '..', 'backend', 'database', 'carousels');
        const archPath = path.join(tdir, `${slug}.html`);
        if (fs.existsSync(archPath)) {
          if (entry.archetype !== archPath) {
            entry.archetype = archPath;
            changed = true;
          }
          if (entry.archetypeSlug !== slug) {
            entry.archetypeSlug = slug;
            changed = true;
          }
        }
      }
    }
  } catch {
    // archetype-map optional / malformed — ignore, fall back to clone output.
  }

  // The archetype IS the deliverable. Success used to be gated on `hasOutput` (the
  // pixel clone), which is retired and pruned — so authored designs stayed stuck at
  // 'cloned' forever and the dashboard never moved. A mapped, on-disk archetype is
  // the completion signal now.
  if (entry.archetype && mutableStatuses.has(normalizeStatus(entry.status))) {
    entry.status = 'success';
    changed = true;
  }

  // Self-heal the inverse: a 'success' with neither an authored archetype nor a
  // pixel-clone output is really just Stage-1 intake — it must read 'cloned', not
  // 'success'. (Older runs marked every completed `run` as success regardless.)
  if (normalizeStatus(entry.status) === 'success' && !entry.archetype && !hasOutput) {
    entry.status = 'cloned';
    changed = true;
  }

  // Attach the gate-derived /10 quality score (score-template.mjs writes
  // template-scores.json, keyed by authored slug) so the dashboard can show it.
  try {
    const scoresPath = path.join(workspaceRoot, 'template-scores.json');
    if (entry.archetypeSlug && fs.existsSync(scoresPath)) {
      const scores = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
      const s = scores[entry.archetypeSlug];
      if (s && typeof s.score === 'number') {
        entry.meta = entry.meta || {};
        if (entry.meta.score !== s.score) { entry.meta.score = s.score; changed = true; }
      }
    }
  } catch {
    // scores optional — ignore.
  }

  if (changed) {
    entry.status = normalizeStatus(entry.status);
    entry.updatedAt = toIsoNow();
  }
  return changed;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDirReplace(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
  ensureDir(path.dirname(targetDir));
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function resolveInputHtml(workspaceRoot, repoRoot, designId, explicitInput, entry) {
  if (explicitInput) {
    const p = path.resolve(explicitInput);
    if (fs.existsSync(p)) return p;
  }
  const fromEntry = entry?.inputHtml ? path.resolve(entry.inputHtml) : null;
  return firstExisting([
    fromEntry,
    path.join(workspaceRoot, 'designs', designId, 'capture', 'editor-page.full.html'),
    path.join(repoRoot, '.tmp', 'canva-template-json', designId, 'editor-page.full.html'),
  ]);
}

function runCloneOnly({ workspaceRoot, repoRoot, designId, inputHtml, dedupeMode, cloneProfile, entry }) {
  if (!inputHtml || !fs.existsSync(inputHtml)) {
    throw new Error(
      `Input HTML not found for design ${designId}. Provide --input-html or capture editor-page.full.html first.`
    );
  }
  const cloneScript = path.join(workspaceRoot, 'scripts', 'canva', 'clone-canva-template.mjs');
  const designRoot = path.join(workspaceRoot, 'designs', designId);
  const captureDir = path.join(designRoot, 'capture');
  const extractDir = path.join(designRoot, 'extract');
  const indexDir = path.join(designRoot, 'index');
  const sharedDedupeIndexPath = path.join(workspaceRoot, 'index', 'template-dedupe-index.json');
  const localDedupeIndexSnapshotPath = path.join(indexDir, 'template-dedupe-index.json');
  ensureDir(captureDir);
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  ensureDir(extractDir);
  ensureDir(indexDir);
  fs.copyFileSync(inputHtml, path.join(captureDir, 'editor-page.full.html'));

  const cloneArgs = (inputPath) => [
    '--input',
    inputPath,
    '--output',
    extractDir,
    '--design-id',
    designId,
    '--dedupe-mode',
    dedupeMode,
    '--dedupe-index',
    sharedDedupeIndexPath,
    '--clone-profile',
    cloneProfile,
  ];

  let cloneInputUsed = inputHtml;
  let cloneRes = runNode(cloneScript, cloneArgs(cloneInputUsed), workspaceRoot);
  let cloneJson = parseJsonOutput(cloneRes.stdout);

  if (cloneRes.status !== 0 || !cloneJson) {
    const reconstructed = firstExisting([
      path.join(path.dirname(inputHtml), 'editor-page.reconstructed.html'),
      path.join(captureDir, 'editor-page.reconstructed.html'),
    ]);
    if (reconstructed) {
      fs.copyFileSync(reconstructed, path.join(captureDir, 'editor-page.reconstructed.html'));
      cloneInputUsed = reconstructed;
      cloneRes = runNode(cloneScript, cloneArgs(cloneInputUsed), workspaceRoot);
      cloneJson = parseJsonOutput(cloneRes.stdout);
    }
  }

  if (cloneRes.status !== 0 || !cloneJson) {
    throw new Error(`Clone step failed.\nSTDOUT:\n${cloneRes.stdout}\nSTDERR:\n${cloneRes.stderr}`);
  }
  if (fs.existsSync(sharedDedupeIndexPath)) {
    fs.copyFileSync(sharedDedupeIndexPath, localDedupeIndexSnapshotPath);
  }

  entry.clone = cloneJson;
  entry.clonedAt = toIsoNow();
  entry.inputHtml = cloneInputUsed;
  entry.extractDir = extractDir;
  entry.duplicate = Boolean(cloneJson.duplicate);
  entry.duplicateOf = cloneJson.duplicateOf || null;
  entry.output = null;
  entry.summary = writeCloneWorkspaceSummary({
    workspaceRoot,
    designId,
    cloneProfile,
    cloneJson,
    inputHtml: cloneInputUsed,
    entry,
  });
  entry.qualityGate = null;
  entry.runId = null;
  entry.generatedAt = null;
  const coverPath = writeCloneCover(workspaceRoot, designId);
  if (coverPath) entry.thumb = coverPath;

  return cloneJson;
}

function runGenerateOnly({ workspaceRoot, designId, targetRmse, stopOnTarget, requireHighResRefs, entry }) {
  const generateScript = path.join(workspaceRoot, 'scripts', 'canva', 'generate-best-pure-clone.mjs');
  const designRoot = path.join(workspaceRoot, 'designs', designId);
  const extractDir = path.join(designRoot, 'extract');
  const finalDir = path.join(designRoot, 'final');
  const runsRoot = path.join(designRoot, 'runs');
  const templateDataPath = path.join(extractDir, 'template-data.json');
  const assetsDir = path.join(extractDir, 'assets');
  const finalOutput = path.join(finalDir, 'template-clone-pure-html.html');

  if (!fs.existsSync(templateDataPath)) {
    throw new Error(`Cannot generate: missing extracted template data at ${templateDataPath}. Run clone first.`);
  }
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Cannot generate: missing extracted assets at ${assetsDir}. Run clone first.`);
  }

  const genArgs = [
    '--design-dir',
    extractDir,
    '--input',
    templateDataPath,
    '--assets',
    assetsDir,
    '--runs-root',
    runsRoot,
    '--output',
    finalOutput,
    '--target-rmse',
    String(targetRmse),
    '--stop-on-target',
    String(stopOnTarget),
    '--require-compared-pages',
    String(Boolean(requireHighResRefs)),
  ];
  const genRes = runNode(generateScript, genArgs, workspaceRoot);
  const genJson = parseJsonOutput(genRes.stdout);
  if (genRes.status !== 0 || !genJson) {
    throw new Error(`Generate step failed.\nSTDOUT:\n${genRes.stdout}\nSTDERR:\n${genRes.stderr}`);
  }

  const summaryPath = path.join(designRoot, 'workspace-summary.json');
  const summary = {
    designId,
    startedAt: entry.startedAt || toIsoNow(),
    finishedAt: toIsoNow(),
    workspaceRoot,
    clone: entry.clone || null,
    best: genJson,
    quality: {
      targetRmse,
      stopOnTarget,
      gate: genJson.qualityGate || null,
    },
    runTracking: {
      runId: genJson.runId || null,
      runDir: genJson.runDir || null,
      report: genJson.report || null,
      output: genJson.runOutput || genJson.output || finalOutput,
      createdAt: toIsoNow(),
      source: 'generate-best-pure-clone',
      duplicate: false,
    },
    final: {
      duplicate: false,
      output: genJson.output || finalOutput,
      duplicateOf: null,
    },
  };
  writeJson(summaryPath, summary);

  const extractAssetsDir = path.join(extractDir, 'assets');
  if (fs.existsSync(extractAssetsDir)) {
    copyDirReplace(extractAssetsDir, path.join(finalDir, 'assets'));
    if (genJson.runOutput) {
      copyDirReplace(extractAssetsDir, path.join(path.dirname(genJson.runOutput), 'assets'));
    }
  }

  entry.summary = summaryPath;
  entry.output = summary.final.output;
  entry.qualityGate = genJson.qualityGate || null;
  entry.runId = genJson.runId || null;
  entry.generatedAt = toIsoNow();
  entry.duplicate = false;
  entry.duplicateOf = null;

  return { genJson, summary };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = String(args.action || 'run').toLowerCase();
  if (!['add', 'clone', 'generate', 'run', 'comparison', 'refresh'].includes(action)) {
    throw new Error('Invalid --action. Use: add | clone | generate | run | comparison | refresh');
  }

  const sourceUrl = String(args.url || args['design-url'] || '').trim();
  const designIdFromUrl = parseDesignIdFromUrl(sourceUrl);
  const designId = String(args['design-id'] || designIdFromUrl || '').trim();
  // `refresh` re-syncs the whole dashboard from disk — it is not scoped to one design.
  if (!designId && action !== 'refresh') {
    throw new Error('Missing --design-id (or provide --url containing /design/<DESIGN_ID>/...)');
  }

  // Standalone: the workspace is the folder that contains this scripts/ dir.
  // (Legacy: --workspace-root override still wins; the old cwd/canva-template-workspace
  // layout also resolves if this script sits under it.)
  const selfRoot = path.resolve(path.dirname(process.argv[1] || '.'), '..');
  const workspaceRoot = args['workspace-root']
    ? path.resolve(args['workspace-root'])
    : selfRoot;
  const repoRoot = path.resolve(workspaceRoot, '..');
  // Final authored templates live in ONE folder inside the workspace (standalone),
  // with a legacy fallback to the old content-gen carousels dir if templates/ is absent.
  const templatesDir = fs.existsSync(path.join(workspaceRoot, 'output'))
    ? path.join(workspaceRoot, 'output')
    : path.resolve(repoRoot, 'backend', 'database', 'carousels');
  const configPath = path.join(workspaceRoot, 'agent.config.json');
  const cfg = readJsonSafe(configPath, {});
  const targetRmse = Number(args['target-rmse'] ?? cfg.targetRmse ?? 0.17);
  const dedupeMode = String(args['dedupe-mode'] || cfg.dedupeMode || 'continue');
  // The faithful pixel clone (generate-best-pure-clone + RMSE autotune) is RETIRED as a
  // deliverable — the archetype is authored from the page thumbnails + template-data.json.
  // Producing it costs ~211 MB of `runs/` per design and downloads Canva's media/fonts,
  // which we never use and must not ship. Opt in explicitly when you want the reference.
  const pixelClone =
    String(args['pixel-clone'] ?? cfg.pixelClone ?? false).toLowerCase() === 'true';

  const requestedCloneProfile = String(args['clone-profile'] || cfg.cloneProfile || '').toLowerCase().trim();
  const cloneProfile = requestedCloneProfile || (pixelClone ? 'full' : 'minimal');
  if (!['full', 'minimal', 'lean'].includes(cloneProfile)) {
    throw new Error(`Invalid --clone-profile '${cloneProfile}'. Use full or minimal.`);
  }
  const stopOnTargetRaw = String(args['stop-on-target'] ?? cfg.stopOnTarget ?? true).toLowerCase();
  const stopOnTarget = stopOnTargetRaw !== 'false';
  // Canva's captured HTML only exposes a high-res reference for page 1; pages 2+
  // are low-res thumbnails (signed per-URL, so no high-res URL can be fabricated).
  // The generate script gained a hard "require high-res refs" guard — default this
  // OFF so the clone still scores against the available refs (the clone is the
  // internal "exact replica" reference, not the deliverable). Flip on to enforce.
  const requireHighResRefs =
    String(args['require-high-res-refs'] ?? cfg.requireHighResRefs ?? false).toLowerCase() === 'true';

  let store = readJsonSafe(path.join(workspaceRoot, 'dashboard-store.json'), {
    version: 1,
    generatedAt: toIsoNow(),
    entries: [],
  });
  const storeEntries = Array.isArray(store?.entries) ? store.entries : [];
  let reconciled = false;
  for (const row of storeEntries) {
    if (reconcileEntryFromWorkspace(workspaceRoot, row)) reconciled = true;
    if (enrichEntryMeta(workspaceRoot, row)) reconciled = true;
  }
  store.entries = storeEntries;
  if (reconciled) {
    store.generatedAt = toIsoNow();
  }

  // `refresh`: re-sync the dashboard from what is actually on disk. Authoring an
  // archetype writes carousels/<slug>.html + archetype-map.json without ever calling
  // this entrypoint, so nothing updated the store. This also adopts design folders
  // that were cloned outside the dashboard flow.
  if (action === 'refresh') {
    const designsRoot = path.join(workspaceRoot, 'designs');
    let adopted = 0;
    if (fs.existsSync(designsRoot)) {
      for (const d of fs.readdirSync(designsRoot, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        if (!fs.existsSync(path.join(designsRoot, d.name, 'extract'))) continue;
        const before = store.entries.length;
        const { list: l2, entry: e2 } = upsertEntry(store.entries, d.name);
        store.entries = l2;
        if (store.entries.length > before) {
          adopted++;
          e2.createdAt = e2.createdAt || toIsoNow();
        }
        reconcileEntryFromWorkspace(workspaceRoot, e2);
        enrichEntryMeta(workspaceRoot, e2);
        e2.updatedAt = toIsoNow();
      }
    }
    const saved = saveDashboard(workspaceRoot, store);
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: 'refresh',
          adopted,
          entries: saved.store.entries.length,
          statuses: statusCounts(saved.store.entries),
          dashboard: saved.htmlPath,
        },
        null,
        2
      )
    );
    return;
  }

  const { list, entry } = upsertEntry(store.entries, designId);
  store.entries = list;

  entry.designId = designId;
  entry.sourceUrl = sourceUrl || entry.sourceUrl || '';
  entry.updatedAt = toIsoNow();
  if (!entry.createdAt) entry.createdAt = entry.updatedAt;
  if (action === 'add' && !entry.status) entry.status = 'pending';
  if (entry.attempts == null) entry.attempts = 0;

  const save = () => saveDashboard(workspaceRoot, store);
  const setStatus = (status) => {
    entry.status = normalizeStatus(status);
    entry.updatedAt = toIsoNow();
    save();
  };

  try {
    if (action === 'add') {
      entry.status = 'pending';
      entry.lastError = '';
      save();
      console.log(
        JSON.stringify(
          {
            ok: true,
            action,
            designId,
            status: entry.status,
            dashboard: path.join(workspaceRoot, 'dashboard.html'),
          },
          null,
          2
        )
      );
      return;
    }

    if (action === 'comparison') {
      const buildScript = path.join(workspaceRoot, 'scripts', 'build-comparison.mjs');
      const cmpArgs = ['--design-id', designId, '--workspace-root', workspaceRoot];
      if (args.archetype) cmpArgs.push('--archetype', String(args.archetype));
      const cmpRes = runNode(buildScript, cmpArgs, repoRoot);
      const cmpJson = parseJsonOutput(cmpRes.stdout);
      if (cmpRes.status !== 0 || !cmpJson) {
        throw new Error(`Comparison build failed.\nSTDOUT:\n${cmpRes.stdout}\nSTDERR:\n${cmpRes.stderr}`);
      }
      entry.comparison = cmpJson.output;
      entry.updatedAt = toIsoNow();
      enrichEntryMeta(workspaceRoot, entry); // pick up the just-written archetype cover thumbnail
      save();
      console.log(
        JSON.stringify(
          {
            ok: true,
            action,
            designId,
            comparison: entry.comparison,
            mode: cmpJson.mode,
            dashboard: path.join(workspaceRoot, 'dashboard.html'),
          },
          null,
          2
        )
      );
      return;
    }

    entry.attempts += 1;
    entry.startedAt = toIsoNow();
    entry.finishedAt = null;
    entry.durationMs = null;
    entry.lastError = '';
    save();

    if (action === 'clone' || action === 'run') {
      const inputHtml = resolveInputHtml(workspaceRoot, repoRoot, designId, args['input-html'], entry);
      setStatus('cloning');
      const cloneJson = runCloneOnly({
        workspaceRoot,
        repoRoot,
        designId,
        inputHtml,
        dedupeMode,
        cloneProfile,
        entry,
      });
      if (cloneJson.duplicate) {
        setStatus('duplicate');
        entry.finishedAt = toIsoNow();
        entry.durationMs = durationMs(entry.startedAt, entry.finishedAt);
        save();
        console.log(
          JSON.stringify(
            {
              ok: true,
              action,
              designId,
              status: entry.status,
              duplicate: true,
              duplicateOf: entry.duplicateOf || null,
              dashboard: path.join(workspaceRoot, 'dashboard.html'),
            },
            null,
            2
          )
        );
        return;
      }
      setStatus('cloned');
    }

    // Pixel clone: legacy/opt-in only. `generate` asks for it explicitly; `run` produces it
    // only with --pixel-clone. Otherwise a `run` finishes at intake (capture → extract →
    // page thumbnails + template-data.json), which is everything the archetype needs.
    if (action === 'generate' || (action === 'run' && pixelClone)) {
      setStatus('generating');
      runGenerateOnly({
        workspaceRoot,
        designId,
        targetRmse,
        stopOnTarget,
        requireHighResRefs,
        entry,
      });
      setStatus('success');
    }
    // A plain `run` finishes at intake (capture → extract → thumbnails +
    // template-data.json). It stays 'cloned' — Stage 1 done, not yet authored.
    // It only becomes 'success' when a brand archetype is authored + mapped (the
    // reconcile promotion). Never mark intake-only as success.

    // Auto-build the Original→Generated + brand-structure comparison at the end
    // of a full run. Non-fatal: the run's deliverable is the generate; a failed
    // comparison (e.g. missing Chrome/magick) must not fail the run. Uses the
    // mapped archetype when present, else falls back to the clone screenshots.
    if (action === 'run') {
      try {
        const buildScript = path.join(workspaceRoot, 'scripts', 'build-comparison.mjs');
        const cmpArgs = ['--design-id', designId, '--workspace-root', workspaceRoot];
        if (args.archetype) cmpArgs.push('--archetype', String(args.archetype));
        const cmpRes = runNode(buildScript, cmpArgs, repoRoot);
        const cmpJson = parseJsonOutput(cmpRes.stdout);
        if (cmpRes.status === 0 && cmpJson?.output) {
          entry.comparison = cmpJson.output;
          enrichEntryMeta(workspaceRoot, entry); // pick up the just-written archetype cover thumbnail
          save();
        } else {
          console.error(`  ~ comparison build skipped: ${(cmpRes.stderr || cmpRes.stdout || '').slice(0, 200)}`);
        }
      } catch (err) {
        console.error(`  ~ comparison build threw (non-fatal): ${err?.message || String(err)}`);
      }
    }

    entry.finishedAt = toIsoNow();
    entry.durationMs = durationMs(entry.startedAt, entry.finishedAt);
    save();

    console.log(
      JSON.stringify(
        {
          ok: true,
          action,
          designId,
          status: entry.status,
          inputHtml: entry.inputHtml || null,
          output: entry.output || null,
          comparison: entry.comparison || null,
          summary: entry.summary || null,
          qualityGate: entry.qualityGate || null,
          dashboard: path.join(workspaceRoot, 'dashboard.html'),
        },
        null,
        2
      )
    );
  } catch (err) {
    entry.status = 'failed';
    entry.finishedAt = toIsoNow();
    entry.updatedAt = entry.finishedAt;
    entry.durationMs = durationMs(entry.startedAt, entry.finishedAt);
    entry.lastError = err?.stack || String(err);
    save();
    console.error(err?.stack || String(err));
    console.error(`Dashboard: ${path.join(workspaceRoot, 'dashboard.html')}`);
    process.exit(1);
  }
}

main();
