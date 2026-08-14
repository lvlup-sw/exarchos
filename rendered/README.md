# `rendered/` — generated. Never edit by hand.

Every file under this directory is produced by `npm run build:skills` from
`content/`. Nothing here is authored, and an edit made here is not a change to
the product — it is a change that the next build silently reverts.

`npm run render:guard` re-renders the whole tree and diffs it against what is
committed. A hand edit fails that check, which is the intended outcome: the
guard exists because a hand edit here looks exactly like a real change in
review, and behaves like nothing at all in production.

## Why it is committed at all

Because the package ships it. `package.json`'s `files[]` names `rendered`, and
the plugin manifest copies `rendered/commands` and `rendered/skills` into a
user's install. Generating at publish time instead would mean the shipped
artifact is never the reviewed one.

## Layout

- `skills/<runtime>/` — one variant per harness runtime, placeholders resolved
  from `content/harness/runtimes/<name>.yaml`.
- `commands/`, `rules/`, `agents/` — the same projection for the other artifact
  kinds.
- `command-aliases/<runtime>/` — emitted only for runtimes that declare
  `canonicalCommandAliases`.

## To change something here

Edit the source under `content/`, run `npm run build:skills`, and commit both.
If the output surprises you, the renderer is `src/install/build-skills/` and
the token table is the runtime YAML — not this tree.
