# Skill Authoring Guide

## Overview

Skills live in two trees. You write source in `skills-src/<name>/SKILL.md` using `{{TOKEN}}` placeholders. A build step renders one variant per runtime into `skills/<runtime>/<name>/SKILL.md`, and both trees are committed. CI re-renders on every push and rejects the PR if `skills/` doesn't match what `skills-src/` would produce — so don't edit the generated tree by hand. It will get overwritten and your PR will fail the guard.

## Editing a skill

```bash
$EDITOR skills-src/<name>/SKILL.md
npm run build:skills
git add skills-src/<name>/ skills/
git commit
```

If your edit doesn't change any rendered byte (e.g. a comment tweak that happens to land on a line every runtime renders identically), `skills/` won't change and you'll only see the `skills-src/` diff. That's fine — commit just the source.

## Adding a new skill

```bash
# 1. Create the source directory
mkdir -p skills-src/<name>/references

# 2. Author SKILL.md with frontmatter
cat > skills-src/<name>/SKILL.md <<'EOF'
---
name: <name>
description: One-line description (<=1024 chars).
metadata:
  mcp-server: exarchos   # only if the skill calls Exarchos MCP tools
---

# Skill body here. Use placeholders like {{MCP_PREFIX}}workflow for
# MCP tool references so the renderer can substitute per-runtime forms.
EOF

# 3. Optionally add reference files (copied verbatim per runtime)
$EDITOR skills-src/<name>/references/<some-ref>.md

# 4. Render
npm run build:skills

# 5. Commit both trees
git add skills-src/<name>/ skills/
git commit
```

Files under `skills-src/<name>/references/` are copied verbatim into every runtime variant. No placeholder substitution, no filtering — what you write is what ships.

## Placeholder vocabulary

See [`docs/references/placeholder-vocabulary.md`](references/placeholder-vocabulary.md) for the authoritative list. The five canonical tokens are:

- `{{MCP_PREFIX}}` — runtime's MCP tool prefix (e.g. `mcp__plugin_exarchos_exarchos__`)
- `{{COMMAND_PREFIX}}` — runtime's slash-command prefix (e.g. `/exarchos:`)
- `{{TASK_TOOL}}` — runtime's task/agent dispatch tool name
- `{{CHAIN(...)}}` — runtime-specific chained-tool invocation form
- `{{SPAWN_AGENT_CALL(...)}}` — runtime-specific subagent dispatch call

A vocabulary lint runs as a pre-flight inside `buildAllSkills()`; any unknown `{{TOKEN}}` reference will fail the build fast with a clear error.

## Adding a new placeholder

When you need a new token:

1. Add it to every `runtimes/*.yaml` `placeholders:` map — the lint refuses to build if any token is unknown to any runtime.
2. Use `{{NEW_TOKEN}}` where needed in `skills-src/`.
3. Run `npm run build:skills` to regenerate.
4. Update `docs/references/placeholder-vocabulary.md` with the new token's meaning.

New placeholders are cheap to add and expensive to maintain — every runtime YAML has to know about every token, forever. Check whether an existing token plus a sentence of prose covers your case before reaching for a new one.

## Adding a new runtime

1. Create `runtimes/<name>.yaml` mirroring the existing files. Required fields:
   - `placeholders:` — map covering every canonical token
   - `skillsInstallPath:` — where `exarchos install-skills` drops the rendered tree for this runtime
   - Capability flags (`supportsBackground`, `supportsSubagents`, etc.) where applicable
2. Add a presence test at `src/runtimes/presence-<name>.test.ts`.
3. Update `src/runtimes/load.ts` `REQUIRED_RUNTIME_NAMES` if the new runtime should be required.
4. Run `npm run build:skills` to materialize the new variant subtree under `skills/<name>/`.
5. Add per-runtime notes to `docs/references/runtime-notes.md` (quirks, unsupported features, sequential-fallback behavior).

Handle capability gaps in `runtimes/<name>.yaml` placeholder values, not by forking skill bodies. The `SKILL.<runtime>.md` override (below) is the last resort, not the first.

## Escape hatch: `SKILL.<runtime>.md` overrides

If a skill genuinely needs a different body for one runtime — rare, but possible — drop a `SKILL.<runtime>.md` next to the canonical file:

```
skills-src/delegation/
├── SKILL.md              # canonical, placeholder-substituted for every runtime
├── SKILL.cursor.md       # used only for the cursor variant
└── references/
```

The build picks up the override automatically. Placeholder substitution still runs on the override file, but the structure is whatever you wrote.

Nothing currently uses this. If you find yourself reaching for it, try a placeholder tweak first.

## CI checks

Three things gate skill PRs:

- **Vocabulary lint** runs as a pre-flight inside `buildAllSkills()`. Unknown `{{TOKEN}}` references fail the build immediately, with the offending file and token name in the error.
- **`skills:guard`** rebuilds the tree in place and fails if `git diff --exit-code skills/` is dirty. This catches forgotten rebuilds (you changed `skills-src/` and didn't re-render) and stale direct edits (you edited `skills/<runtime>/` and the next rebuild blew it away).
- **Snapshot tests** at `test/migration/snapshots.test.ts` pin every generated SKILL.md byte-for-byte. If you intentionally change the renderer, regenerate baselines with:

  ```bash
  npx vitest run test/migration/snapshots.test.ts -u
  ```

  Read the snapshot diff before committing it. That diff is the only place a subtle renderer regression will surface before users hit it.

A tier-1 smoke harness at `test/smoke/runtime-smoke.test.ts` covers per-runtime substitution correctness. The Claude runtime runs on every test invocation; the rest are gated behind `SMOKE=1` to keep the default suite fast.

## Where to look next

- Design: [`docs/designs/2026-04-08-platform-agnostic-skills.md`](designs/2026-04-08-platform-agnostic-skills.md)
- Plan: [`docs/plans/2026-04-08-platform-agnostic-skills.md`](plans/2026-04-08-platform-agnostic-skills.md)
- Placeholder vocabulary: [`docs/references/placeholder-vocabulary.md`](references/placeholder-vocabulary.md)
- Runtime notes: [`docs/references/runtime-notes.md`](references/runtime-notes.md)
