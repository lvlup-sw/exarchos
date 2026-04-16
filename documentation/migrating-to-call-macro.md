---
outline: deep
---

# Migrating to `{{CALL}}` Macros

**Status:** Transition guide for skill authors. This page explains how to move existing skill sources from raw `mcp__…` tool references to the new facade-agnostic `{{CALL}}` placeholder macro introduced by the dual-facade skill rendering work.

For the broader context on why Exarchos ships two invocation surfaces (MCP and CLI), see [Facade and Deployment Choices](./facade-and-deployment.md).

## What changed

Skills used to hard-code the MCP tool-call form directly in their source, for example `mcp__plugin_exarchos_exarchos__exarchos_workflow(...)`. That form only makes sense on MCP-preferred runtimes; CLI-preferred runtimes (OpenCode, Copilot CLI, the generic fallback) either ignored the call or required the author to hand-roll a parallel `Bash(exarchos ...)` variant.

The build pipeline now owns this split. A single source authored with a `{{CALL}}` macro renders to:

- an MCP `tool_use` invocation on runtimes whose `preferredFacade` is `mcp`, and
- a `Bash(exarchos <command> …)` invocation on runtimes whose `preferredFacade` is `cli`.

The choice is made per-runtime at build time, driven by the `preferredFacade` field on each runtime's YAML configuration. Skill authors write one line; the renderer produces the right form for each of the six runtime variants.

## Before and after

**Before** — a skill source pinned to the MCP facade:

```markdown
To advance the workflow, invoke:

mcp__plugin_exarchos_exarchos__exarchos_workflow({
  action: "set",
  featureId: "my-feature",
  phase: "plan"
})
```

**After** — the same skill using `{{CALL}}`:

```markdown
To advance the workflow, invoke:

{{CALL exarchos_workflow set {"featureId": "my-feature", "phase": "plan"}}}
```

The macro takes three positional parts: the composite tool name, the action, and a JSON object of arguments. On an MCP-preferred runtime this renders to the MCP tool_use form above. On a CLI-preferred runtime the same source renders to:

```bash
Bash(exarchos workflow set --feature-id my-feature --phase plan --json)
```

Field names are lowered to kebab-case (`featureId` → `--feature-id`), boolean `true` values become bare flags (`dryRun: true` → `--dry-run`), and `--json` is always appended so the response shape matches the MCP `ToolResult` contract.

## Why migrate

- **Portability across runtimes.** One source renders cleanly to both MCP-native hosts (Claude Code, Cursor, Codex) and CLI-only hosts (OpenCode, Copilot CLI, generic fallback). No more parallel forks of the same skill.
- **Build-time validation.** CALL macros are validated against the `TOOL_REGISTRY` during `npm run build:skills`. Unknown tool names, unknown actions, or malformed arg JSON fail the build with the source file path and line number — not at runtime, in front of an agent that has already consumed tokens.
- **Fewer hand-rolled prefixes.** The `mcp__plugin_exarchos_exarchos__` prefix, action-name case conventions, and JSON-arg shape are all derived from the registry. Authors stop maintaining them by hand.
- **Single source of truth.** The dual-facade rendering model keeps the invocation surface out of skill sources so facade-level changes (new flags, new runtimes, renamed tools) propagate automatically on the next rebuild.

## Transition window

Raw `mcp__…` references in skill sources still work. The build does not rewrite them and does not fail CI. During the transition window, every raw reference emits a placeholder-lint **warning** with the source file and line number:

```
[skills-lint] warning: skills-src/delegation/SKILL.md:42 — raw mcp__… reference; migrate to {{CALL}} macro (DR-2).
```

Authors who want to enforce the migration early in their own workflow can flip warnings to errors by exporting `EXARCHOS_LINT_STRICT=1` before running the build. Under strict mode the same reference fails the build rather than warning.

## When it will close

One minor version after this ships, the lint default flips to **error**. Raw `mcp__…` references will then fail the build without any opt-in. A follow-up GitHub issue will track the exact version bump and schedule.

This gives existing skill authors at least one release cycle to migrate on their own cadence. New skills should be written with `{{CALL}}` from the start.

## Escape hatch

The lint warning always includes the source file and line number of the raw reference, so incremental migration is straightforward:

1. Run `npm run build:skills` and collect the warnings from stderr.
2. Open each reported file/line and rewrite the raw call to the `{{CALL}}` form.
3. Re-run the build; warnings disappear once the last raw reference is migrated.
4. Optionally set `EXARCHOS_LINT_STRICT=1` locally to guarantee no new raw references slip back in before the default flips.

If a CALL macro fails to render — for example because the tool name is wrong or an argument is missing — the error message points at the same source file and line, so the fix loop stays local to the skill source.

## Further reading

- [Facade and Deployment Choices](./facade-and-deployment.md) — background on the two invocation surfaces and how runtimes declare their preferred facade.
- [`docs/references/placeholder-vocabulary.md`](https://github.com/lvlup-sw/exarchos/blob/main/docs/references/placeholder-vocabulary.md) — full list of placeholder tokens recognised by the renderer.
- [`docs/skills-authoring.md`](https://github.com/lvlup-sw/exarchos/blob/main/docs/skills-authoring.md) — end-to-end guide for editing skills and running the build.
