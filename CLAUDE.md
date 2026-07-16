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

## Stage 2 — Generate

The GOAL is **faithful reproduction + recolor**: rebuild the reference's layout/copy/devices closely as
a brand-recolorable, editor-injectable template (NOT "invent an original design" — that pivot hurt
quality and was reverted; see agent memory `faithful-repro-pivot`). Two ways to run it:

### A) Batch command (`generate-worker.mjs`) — self-driving, uses the Azure model

Walks the `cloned` queue and, per design: transcribes the reference faithfully, feeds the author EXACT
geometry (`decode-geometry.mjs` → real font-sizes/box-sizes so it stops eyeballing), runs the contract +
verify gates with a bounded repair loop, injects a deterministic occlusion guard (text always above
surfaces), then a **faithfulness vision loop** — renders the deck, shows the model each slide beside its
reference, and RE-AUTHORS from sight until collisions/occlusion/missing/chrome defects clear. Ships to
`output/<slug>.html`, maps the archetype, rebuilds the comparison, flips **cloned → success**.

```bash
node scripts/generate-worker.mjs                 # every cloned design, one by one
node scripts/generate-worker.mjs --once          # just the next one
node scripts/generate-worker.mjs --design-id <ID># a specific design
node scripts/generate-worker.mjs --slide <N>     # author ONLY reference page N → output/_slide-*.html preview (fast per-slide quality probe; needs --design-id)
node scripts/generate-worker.mjs --provider claude   # override GEN_PROVIDER (codex|claude)
```

Self-driving batch — start it and let it drain the queue. Output in `output/`; dashboard shows before/after.

### B) CLI agent (`template-author-agent`) — higher fidelity, the model authors by hand

Same deliverable, but the model authors holistically, RENDERS, LOOKS at the pixels, and iterates — which
beats the pipeline (same model, no blind one-shot). Use when the user says "generate the template for
<design-id>" and wants top quality. Runbook: `.claude/agents/template-author-agent.md` (in THIS repo).
New agent files need a Claude Code restart to be spawnable by type; until then run it via a
`general-purpose` (opus) agent told to Read and follow that runbook.

## Concurrency — other chats/agents may be working RIGHT NOW

This workspace is routinely driven from **several chats at once** (a clone agent here, a remix/author
agent there). Treat every shared path as live, not yours.

- **NEVER `rm -rf` a shared dir** — `output/`, `output/.verify/`, `replicas/`, `designs/`. Another
  chat's agent may be mid-run and you will destroy its in-progress work. (This has happened: wiping
  `output/.verify/` to "clean up" deleted a live agent's renders.)
- **Scope every delete to your own artifact**: only `output/.verify/<your-slug>/`, and only for a
  template this session created. If you did not create it, do not delete it — ask.
- **Need a clean render dir to test?** Use `verify-slides.mjs <html> --out <scratch-dir>` — never wipe
  the real one.
- **Renders are per-template**: `verify-slides.mjs` writes `<dir-of-html>/.verify/<template-name>/`,
  so parallel runs never collide. Read only `output/.verify/<slug>/slide-NN.png` (the command prints
  the dir it wrote). Never point a compare board at bare `.verify/` — it will show whichever deck
  rendered last.
- **Before touching a file you didn't create**, check it's not live: `ls -l --time-style=+%H:%M:%S`
  — a recent mtime means an agent is working on it. Leave it alone.
- **Changing a shared script** (e.g. `verify-slides.mjs` paths) while agents run will break them
  mid-flight: they loaded their runbook at spawn and follow the OLD contract. Prefer backwards-
  compatible changes, or wait until nothing is running.

## Notes

- Repo is standalone (root IS the workspace); scripts self-resolve their root — plain `scripts/…`.
- The Stage-2 CLI authoring rules live in `.claude/agents/template-author-agent.md` in THIS repo
  (ships to `output/`). A separate older copy exists in the `content-gen` repo (ships to `backend/`).
- Dedupe is by fingerprint, not URL — a recolor of a base template is a real `duplicate`.
