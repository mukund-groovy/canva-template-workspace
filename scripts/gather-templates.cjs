// Standalone step 1: gather all final authored templates into ONE folder
// (canva-template-workspace/templates/) and repoint the dashboard's archetype
// (Template button) paths there, decoupling from content-gen/backend.
const fs = require('fs');
const path = require('path');

const WS = 'C:\\Users\\Groovy\\Projects\\canva-template-workspace';
const SRC = 'C:\\Users\\Groovy\\Projects\\content-gen\\backend\\database\\carousels';
const OUT = path.join(WS, 'templates');
fs.mkdirSync(OUT, { recursive: true });

const map = JSON.parse(fs.readFileSync(path.join(WS, 'archetype-map.json'), 'utf8'));
const slugs = [...new Set(Object.entries(map).filter(([k]) => !k.startsWith('_')).map(([, v]) => v))];

let copied = 0, missing = [];
for (const slug of slugs) {
  const src = path.join(SRC, `${slug}.html`);
  if (!fs.existsSync(src)) { missing.push(slug); continue; }
  fs.copyFileSync(src, path.join(OUT, `${slug}.html`));
  copied++;
}
console.log(`templates gathered into templates/: ${copied}/${slugs.length}` + (missing.length ? ` | MISSING: ${missing.join(', ')}` : ''));

// repoint archetype paths in the dashboard: content-gen\backend\database\carousels -> canva-template-workspace\templates
const re = /content-gen[\\/]+backend[\\/]+database[\\/]+carousels/g;
for (const f of ['dashboard-store.json', 'dashboard.html']) {
  const p = path.join(WS, f);
  let s = fs.readFileSync(p, 'utf8');
  const n = (s.match(re) || []).length;
  s = s.replace(re, 'canva-template-workspace\\\\templates');
  const leftover = (s.match(/content-gen/g) || []).length;
  fs.writeFileSync(p, s);
  console.log(`${f}: repointed ${n} archetype paths -> templates/ | content-gen refs left: ${leftover}`);
}
