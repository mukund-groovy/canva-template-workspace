// Migrate absolute workspace paths in the dashboard store to workspace-RELATIVE.
//
// The store is shared across machines (it's checked in), so an absolute root baked
// into it — C:\Users\Groovy\Projects\canva-template-workspace on one box,
// D:\wamp64\www\canva-template-workspace on another — renders a dashboard of broken
// images on whichever box didn't write it. agent-canva-clone.mjs now persists
// relative paths; this repairs stores written before that.
//
//   node scripts/fix-moved-paths.cjs [--dry]
//
// Idempotent: already-relative paths are left alone. Paths outside the workspace
// (e.g. content-gen\backend, which did not move) stay absolute.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dry = process.argv.includes('--dry');

// One whole path string: the absolute workspace root (whatever machine wrote it,
// separators raw or JSON-escaped) plus everything up to the closing quote. Only the
// remainder is rewritten, so backslashes elsewhere in the file are never touched.
const WS_PATH = /[A-Za-z]:(?:\\\\|[\\/])[^"'\n]*?canva-template-workspace(?:\\\\|[\\/])?([^"'\n]*)/g;

function migrate(file) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return console.log(`${file}: MISSING`);
  const src = fs.readFileSync(p, 'utf8');
  let n = 0;
  // Drop the root prefix -> the remainder IS the workspace-relative path.
  const out = src.replace(WS_PATH, (_m, rest) => {
    n++;
    return String(rest).replace(/\\\\|\\/g, '/');
  });
  const left = (out.match(/[A-Za-z]:(?:\\\\|[\\/])[^"'\n]*canva-template-workspace/g) || []).length;
  if (!dry) fs.writeFileSync(p, out);
  console.log(
    `${file}: relativized ${n} path(s)${left ? ` | WARNING: ${left} absolute left` : ''}${dry ? '  (dry run)' : ''}`
  );
}

for (const f of ['dashboard-store.json', 'dashboard-data.js']) migrate(f);
console.log(`\nworkspace root (resolved, not hardcoded): ${root}`);
