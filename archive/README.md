# archive

Retired deliverables. Nothing here is live: the dashboard derives its rows from `output/`,
so these templates no longer own a design's row and their designs read `cloned` again.

## `output/` — faithful reproductions (`template-author-agent`)

Authored before **2026-07-16**, when "generate the template for `<id>`" meant *reproduce the
Canva reference closely*. That is no longer the default — `generate` now means **remix**
(`template-remix-agent`): keep the reference's design language, invent the content. A faithful
repro is a near-verbatim copy of someone else's Canva template, placeholder text and all.
See `CLAUDE.md` Stage 2 and agent memory `template-authoring-intent`.

| slug | design | note |
|---|---|---|
| `purple-minimalist-carousel` | DAHOrBKyBxs | 8.2/10 — remixed as `write-better-emails` (8.8) |
| `how-to-become` | DAHPRMKHicM | remixed as `the-drawn-line` (10/10) |
| `quiet-reminders-nights` | DAHPhC76mo0 | reference thumbs are 1:1, deck is 4:5 — unresolved format mismatch |
| `read-forty-books` | DAHPhRtnWw4 | |
| `brown-and-cream` | DAHPVfvXB5k | |

`archetype-map.json` here records the design → slug pairs these had, so a restore is just:
move the file back to `output/`, put its entry back in the root `archetype-map.json`, and run
`node scripts/agent-canva-clone.mjs --action refresh`. Reconcile derives the rest from disk.
