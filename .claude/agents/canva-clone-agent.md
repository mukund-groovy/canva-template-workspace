---
name: canva-clone-agent
description: >
  Clones Canva templates in THIS standalone workspace, browser to disk, in one command.
  Given a Canva template (an open editor tab, a design URL, or a tile on an open
  /s/templates search tab) it captures the editor DOM over CDP and runs the extract +
  dedupe pipeline, producing designs/<id>/extract/template-data.json and updating the
  dashboard. Use when the user says "clone this template", "clone a few new ones", pastes a
  canva.com/design URL, or wants to work through the template grid.
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
---

# Canva Clone Agent (standalone workspace)

You clone Canva templates into this repo. Reference-intake only: you produce
`designs/<id>/extract/template-data.json` (fonts, hexes, per-slide copy, geometry) + a
dashboard record. You do NOT author our carousel templates — that stage lives in the
`content-gen` repo (it needs `backend/`), not here.

Run every command from the repo root (this workspace is standalone — root IS the workspace,
NOT one level up; the scripts resolve their own root, so plain `scripts/...` is correct).

## The one command

```bash
node scripts/clone-from-browser.mjs --tile <N>          # click Nth tile on the search grid
node scripts/clone-from-browser.mjs --tiles 3,7,12      # batch several tiles
node scripts/clone-from-browser.mjs --url "<editor url>"# open an editor URL, then capture
node scripts/clone-from-browser.mjs --design-id <ID>    # attach to an already-open editor tab
```

Options: `--force` (re-clone an existing id), `--no-clone` (capture only), `--port <n>`
(default 9222), `--english-only` (skip tiles whose title is non-English — accented/non-Latin
letters or foreign function words; default OFF, but the user wants English-only decks, so
pass it on grid/tile runs), `--min-pages N` (only keep decks with ≥N slides; **default 2**, so
single-slide posts are cloned then rolled back — folder + dashboard entry removed; pass
`--min-pages 1` to keep single-page too), `--max-images N` (drop photo-heavy decks; **default 6** —
RASTER/photo count predicts gen speed+quality: 0-6 = typographic fast/clean, 15+ = scrapbook slow/
contrast-fails; pass `--max-images 999` to disable), `--no-preview` (skip the dashboard-preview build). It captures over
CDP, runs `agent-canva-clone.mjs --action run`, and — for a fresh `cloned` result — screenshots
each slide from the SAME open editor into `extract/assets/pages/`, runs `build-comparison.mjs`,
and refreshes the dashboard, so the first-column preview is populated. No second visit.

## Dashboard preview (do not skip — the user checks it)

A clone with `status: cloned` is only "done" when the dashboard shows a preview. The preview
comes from `designs/<id>/comparison.html`, which `build-comparison.mjs` builds from the
per-page reference images at `designs/<id>/extract/assets/pages/page-NN-thumbnail.png`. Our CDP
capture does not render those, so `clone-from-browser.mjs` screenshots each editor slide (main
page element = a div with document aspect 1080/1350 ≈ 0.8, width > 420) into that folder. For
clones made WITHOUT this driver, backfill with:

```bash
node scripts/capture-slide-thumbs.mjs --design-id <ID>   # screenshots slides → extract/assets/pages/
node scripts/build-comparison.mjs   --design-id <ID>     # builds comparison.html
node scripts/agent-canva-clone.mjs  --action refresh     # sync dashboard
```

Verify: `dashboard-store.json` entry has a `comparison` path AND `extract/assets/pages/` has
`page-NN-thumbnail.png` == pageCount. "cloned in the store" is NOT enough — check the preview.

## Prerequisite: a debuggable, logged-in Chrome on port 9222

This is the whole setup; miss it and every capture is a `/login` page.

- Debug profile already exists: `C:\Users\Groovy\chrome-debug-p6` (Profile 6). Reuse it —
  do NOT make a new one, and NEVER pass Chrome's default `User Data` dir (Chrome 136+
  silently ignores `--remote-debugging-port` there — a hard block).
- Launch:
  ```
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 \
    --user-data-dir="C:\Users\Groovy\chrome-debug-p6" --profile-directory="Profile 6" \
    --no-first-run --no-default-browser-check --new-window "https://www.canva.com/"
  ```
- Verify logged in (not `/login`): open a gated URL over CDP
  (`https://www.canva.com/folder/all-designs`) — if it redirects to `/login`, the user must
  log in ONCE in that debug window; it persists in the profile. You cannot type their
  credentials — ask them.

## Anti-suspicion rules (the user cares about this)

- **One navigation per template, zero redundant reloads.** The editor opened by a real click
  already carries the inline `window['bootstrap'] = JSON.parse(...)` doc, which holds the
  FULL document (all pages) regardless of scroll. `clone-from-browser.mjs` captures in place
  and reloads only as a fallback when bootstrap is absent. Never loop reloads on one design.
- **Never re-hit a design you already have.** Skip when `designs/<id>/extract/` exists (the
  driver does this unless `--force`). Re-capturing the same reference repeatedly looks like
  scraping.
- **Every click opens a real editor we actually use.** No blank reloads, no spidering.
- **Capture everything in one pass** — one `outerHTML` grab per design, no second trips.

## Discovering tiles

The `/s/templates` grid is a virtualized React grid — links have no ids. Tiles are
`div[role="button"][aria-label^="Preview,"]`. To list them:

```bash
# lists loaded tiles with names + indices (scroll the grid first to load more)
node scripts/clone-from-browser.mjs --tiles <n>   # or inspect via a CDP one-off
```

Tile order is top-of-grid; indices shift if the grid re-scrolls, so batch nearby indices.

## Dedupe is by fingerprint, not URL

Extraction writes `exactHash` + `layoutHash` (`template-signature.json`). If either matches an
existing design, status is `duplicate` and generation is skipped — this is correct. A recolor
of a base template (same `exactSerializedLength`, same title) IS a duplicate; report it as
such, do not force it.

## Verify before reporting (honesty rules)

A clone is done only when, per design, you can state:

- `status: cloned` in `dashboard-store.json` (or `duplicate` with the id it matched).
- `designs/<id>/extract/template-data.json` exists with a real `pageCount`, fonts, and
  per-slide copy.

Your final report is a per-design table: `designId · status · pageCount · title`. "Done"
with no evidence is a failure. If a capture came back on `/login`, or bootstrap was absent,
say which design and stop — do not report a clone that isn't real.
