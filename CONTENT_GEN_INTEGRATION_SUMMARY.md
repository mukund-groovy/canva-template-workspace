# In plain terms: what needs to happen to use these templates in content-gen

This is the easy-language version. For the full technical detail with file names and code, see
`CONTENT_GEN_INTEGRATION_PLAN.md` in this same folder.

## The short version

Good news first: the templates this workspace is generating are **already built the right way**
on the inside — same overall structure, same "brand color" system, same wrapper tags that
content-gen expects. That wasn't an accident — this workspace's quality checks were built by
copying the real rules from content-gen's code, so most of the hard work of "will this even fit"
is already done.

But there are a few real, specific things that would break or look wrong once these templates
are actually used inside content-gen. Here they are, in order of how much they matter:

## 1. Two templates have a color that will never change with the brand (fix this first)

Every template has a small set of "brand colors" (like your logo color, your accent color) that
are supposed to automatically re-paint the whole design when a different brand uses it. In **2 of
the 16 finished templates** (`price-your-worth` and `street-photography-diary`), one of these
colors — the "highlight" color — is wired to the wrong thing internally. It will always show the
same fallback color no matter what brand applies it. Everywhere else (14 of 16), it's wired
correctly.

**Why it happened**: the instructions we give the AI when it builds each template say "use these
9 color names" but don't say exactly which brand color each one should point back to. Most of the
time the AI guesses right; twice it didn't.

**The fix is simple and safe**: change one line in each of those 2 files to point to the color
that actually exists. No visual change — it'll look identical, it'll just actually work when a
different brand uses it. We can also update the instructions so this stops happening in future
templates altogether.

## 2. Templates with real photos are way too big (huge, but easy to solve)

Some templates have real AI-generated photos baked directly into the file. That makes those
files **enormous** — one of them is over 16 megabytes, compared to about 28 kilobytes for a
template with no photos. That's roughly 500 times bigger.

content-gen doesn't work that way — it keeps templates small by using a placeholder ("get me a
photo about X") and finding the actual photo only when someone actually uses the template. Our
templates should do the same: instead of baking in one specific AI photo forever, we hand over
the *description* of what photo the slot wants, and let content-gen find or generate the actual
photo at the time someone actually uses it. We already write a very good, specific description
for every photo slot — we just need to hand that description over instead of the baked photo
itself.

**Why this matters**: a 16MB file checked into a database or a code repository is genuinely a
problem — slow to load, slow to save, and likely to just get rejected outright by size limits.
This is the single most important practical fix on this whole list.

## 3. One color name doesn't quite match content-gen's own naming (tiny, cosmetic)

There's a color name our templates use — `--on-accent` — that content-gen expects to be called
`--on-fill` instead. The color itself is correct either way, this is purely a naming mismatch.
It won't break anything, but it will show up as a nagging warning every time content-gen checks
the file. Simple rename, no visual change.

## 4. Every template needs a "listing card" written for it (busywork, not a bug)

content-gen doesn't just drop a file in a folder and go — every template needs a small write-up:
a name, a one-line description, a category (like "business" or "lifestyle"), and some tags so
the recommendation system knows when to suggest it. None of that exists yet for any of our
templates, because it's not something this workspace produces — it's something content-gen
needs added on its side, once, per template. Not hard, just needs doing for each of the (soon)
~55 templates. We've sketched a fast way to draft most of it automatically with a human just
confirming the category and tone.

## 5. A couple of small "worth checking" items — not urgent

- One attribute (`data-cg-slide-type`) is written on every one of our slides, matching what
  content-gen's own templates do — but nobody could find code in content-gen that actually reads
  it. It's probably fine to keep writing it, but it's worth a quick "does anyone actually use
  this?" question to whoever owns content-gen's front-end, just so we're not carrying forward a
  dead convention forever.
- This workspace has never produced a "single image" (one-page, not a multi-slide carousel) post.
  content-gen supports that as a separate format. If more of those are wanted, that's a new thing
  to build here, not a tweak to what already exists.

## What does NOT need to change (so nobody wastes time "fixing" things that are fine)

- The overall skeleton of every template (the outer wrapper, the slide sections, the color
  system) — already correct.
- No thumbnail image is needed — content-gen generates its own live preview, it doesn't need one
  from us.
- The little marker we put on photo slots (`data-image="true"`) — harmless either way, content-
  gen just ignores it.
- Templates with no logo/brand-name area on them — that's optional in content-gen too, plenty of
  their own templates skip it on purpose.

## Bonus: a few ideas that would make content-gen itself stronger

While comparing the two systems closely, a few gaps showed up in content-gen's *own* checking
that are worth fixing regardless of this migration:

- Our own quality checks catch a few real problems (like "this text box has no label so an AI
  might dump a huge paragraph into it," or "two photos are crammed into one slide and only the
  first one will ever get swapped out") that content-gen's own checks don't currently catch. It
  would be worth adding those same checks to content-gen directly — they'd help protect
  content-gen's *existing* 39 templates too, not just the new ones coming from here.
- There's no automatic way for content-gen to notice if someone edits a template file on disk but
  forgets the required "re-save it to the database" step afterward — a small safety check here
  would prevent a template silently going stale.

## Bottom line

Nothing here requires starting over or rethinking how these templates get built. It's five
concrete fixes (two of them one-line edits, one of them a naming rename, one of them a format
change for photos, one of them just writing some descriptive text per template) plus a couple of
"worth asking someone" follow-ups. The hard part — making the templates structurally correct in
the first place — is already done.
