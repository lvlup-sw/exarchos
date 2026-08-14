# `docs/` — two files, and a mount point

This directory holds what describes the system that EXISTS:

- [`system-design.html`](system-design.html) — the canonical statement of the
  nine-layer architecture.
- This README.

Everything else has been relocated to the `lvlup-sw/docs` repository under the
`exarchos/` key, with source paths preserved. That is roughly 550 documents:
designs, plans, research, ADRs, RCAs, audits, guides, proposals, runbooks, and
the accumulated specs of every workflow this repository has run.

## Why they left

They were planning artifacts. A design records what someone intended to build,
which stops being true the moment the code disagrees, and nothing here reads
them — measured, not assumed: of 362 references into those trees, **zero** were
a program reading a document. 200 were paths in comments, and 128 of those
named a directory the comment policy already forbids citing, on the stated
grounds that the document may move out of this repository.

Keeping them made the repository look like it documented itself while the
documentation described a system several refactors out of date.

## Reading them anyway

```bash
# with lvlup-sw/docs cloned beside this repository
npm run docs:mount      # symlink every relocated subtree back into place
npm run docs:unmount
```

The links are gitignored: a committed symlink stores its target as file
content, so it would hard-code one machine's layout and dangle in every other
checkout. Mounted, an old path such as `docs/designs/…` resolves exactly as it
used to.

## What belongs here

Something that describes the system as it is now, and that a reader is expected
to consult. Almost nothing qualifies — architecture that changes with the code
belongs beside the code, and the six directory READMEs carry the rest.

## What does not

Anything dated. A design, a plan, a proposal, an audit, a retrospective, a
record of a decision — those are the documents repository's job. **A document
added here is relocatable by default**: `tools/audit/prose-manifest.ts` names
the ones that stay and requires each to state why it is READ rather than merely
mentioned, and a test enforces that a new file is not quietly retained.
