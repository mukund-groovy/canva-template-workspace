# Canva Template Workspace — project guide

Standalone engine that clones Canva templates and authors brand-recolorable carousel
templates from them. Two stages, two entry points.

## Prerequisite (both stages)

A debuggable Chrome logged into Canva on port **9222**, using a dedicated debug profile
dir — never Chrome's default `User Data` dir (Chrome 136+ blocks the debug port there).

The profile dir is **machine-specific** — it depends on the Windows user and where that
box keeps its logged-in Canva profile, so it is NOT hardcoded here. Check the agent's
memory for this machine's value (e.g. `chrome-debug-profile`) before launching. Two known
setups:

- Groovy box: `C:\Users\Groovy\chrome-debug-p6` with `--profile-directory="Profile 6"`
- mukun box: `C:\Users\mukun\chrome-debug-p6` (fresh default profile, no `--profile-directory`)

Launch (substitute this machine's dir):

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 \
  --user-data-dir="<this machine's debug profile dir>" \
  --no-first-run --no-default-browser-check --new-window "https://www.canva.com/"
```

If a gated URL (`canva.com/folder/all-designs`) redirects to `/login`, log in ONCE in that
window; it persists. Generation also needs the Azure keys in `.env` (already configured):
`AZURE_OPENAI_*`, `AZURE_TEXT_MODEL`, `AZURE_IMAGE_*`, `GEN_PROVIDER` (codex | claude).

## Stage 1 — Clone (agent: `canva-clone-agent`)

Captures a Canva template's editor DOM → `designs/<id>/extract/` + dashboard preview. Use the
**`canva-clone-agent`** subagent (`.claude/agents/canva-clone-agent.md`) whenever the user says
"clone this template", "clone a few", pastes a `canva.com/design` URL, or works the template grid.
It wraps one command:

```bash
node scripts/clone-from-browser.mjs --tiles 3,7,12 --english-only   # grid tiles
node scripts/clone-from-browser.mjs --url "<editor url>"            # a specific design
node scripts/clone-from-browser.mjs --design-id <ID>               # an already-open editor
```

Captures in one pass (no redundant reloads), dedupes by content hash, screenshots each slide,
builds the dashboard preview, and refreshes — all in the same editor session. `--english-only`
skips non-English titles; `--min-pages N` (default **2**) keeps only multi-slide decks;
`--max-images N` (default **6**) drops photo-heavy decks — the RASTER (photo) count strongly
predicts generation speed + quality (0-6 photos = typographic, fast + clean; 15-53 = scrapbook/
collage, slow image-gen + text-on-photo contrast fails). Single-slide/photo-heavy decks are
cloned then rolled back (counts are only known post-extract). Pass `--max-images 999` to disable
the photo cap. Done = `status: cloned` + a `comparison` preview + `page-NN-thumbnail.png` == pageCount.

## Stage 2 — Generate (batch command, NO agent)

`generate-worker.mjs` walks the `cloned` queue and authors an original, brand-recolorable
carousel template for each (vision model plans + writes copy, fills photos, runs the contract +
verify gates with a bounded repair loop, best-of-N by score, ships to `output/<slug>.html`,
maps the archetype, rebuilds the comparison, and flips status **cloned → success**). Just run:

```bash
node scripts/generate-worker.mjs                 # generate EVERY cloned design, one by one, until none left
node scripts/generate-worker.mjs --once          # just the next one
node scripts/generate-worker.mjs --design-id <ID># a specific design
node scripts/generate-worker.mjs --max 5         # cap the batch
node scripts/generate-worker.mjs --provider claude   # override GEN_PROVIDER (codex|claude)
```

It is a self-driving batch — do not build an agent around it; just start it and let it drain the
queue. Output templates land in `output/`; the dashboard (`dashboard.html`) shows before/after.

## Notes

- Repo is standalone (root IS the workspace); scripts self-resolve their root — plain `scripts/…`.
- The Stage-2 authoring rules live in `.claude/agents/template-author-agent.md` in the separate
  `content-gen` repo (it ships to `content-gen/backend/`); this repo ships to `output/` instead.
- Dedupe is by fingerprint, not URL — a recolor of a base template is a real `duplicate`.
