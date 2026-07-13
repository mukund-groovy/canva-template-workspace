// Repoint stale absolute paths after the workspace was moved out of content-gen.
// Only rewrites the workspace's own paths (designs/replicas/etc.); leaves
// content-gen\backend paths alone (backend did not move).
const fs = require('fs');
const path = require('path');

const root = 'C:\\Users\\Groovy\\Projects\\canva-template-workspace';
const files = ['dashboard-store.json', 'dashboard.html'];

// content-gen<sep>canva-template-workspace  ->  canva-template-workspace
// sep is one-or-more of \ or / (JSON stores Windows sep as an escaped backslash pair).
const re = /content-gen[\\/]+canva-template-workspace/g;

for (const f of files) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { console.log(f, 'MISSING'); continue; }
  let s = fs.readFileSync(p, 'utf8');
  const before = (s.match(/content-gen[\\/]+canva-template-workspace/g) || []).length;
  s = s.replace(re, 'canva-template-workspace');
  const backendLeft = (s.match(/content-gen[\\/]+backend/g) || []).length;
  fs.writeFileSync(p, s);
  console.log(`${f}: rewrote ${before} workspace paths | content-gen\\backend refs left intact: ${backendLeft}`);
}
