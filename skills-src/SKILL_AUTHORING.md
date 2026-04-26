# Skill Authoring Guide

Skill source lives under `skills-src/<name>/SKILL.md` (plus optional
`references/` and `SKILL.<runtime>.md` overrides). The renderer
(`src/build-skills.ts`) emits per-runtime variants under
`skills/<runtime>/<name>/` from a single source.

This file documents the two extension points authors interact with:
the **token vocabulary** for runtime-specific text substitution, and
the **`<!-- requires:* -->` guards** for runtime-specific block
elision.

## Decision rule

Tokenize when a sensible non-Claude rendering exists; guard otherwise.
A token must declare a value for every runtime — if you cannot write
one, the call site belongs inside a `<!-- requires:* -->` block.

## Token vocabulary

Every token in `RuntimeTokenKey` (see `src/runtimes/types.ts`) must be
declared in every `runtimes/*.yaml` placeholders map. The build
pre-flight (`assertRuntimeTokenCoverage`) fails with a single
aggregated error if any runtime lacks any required token.

| Token                       | Claude                              | Codex                                 | OpenCode / Cursor / Generic         | Copilot                  |
| --------------------------- | ----------------------------------- | ------------------------------------- | ----------------------------------- | ------------------------ |
| `MCP_PREFIX`                | `mcp__plugin_exarchos_exarchos__`   | `mcp__exarchos__`                     | `mcp__exarchos__`                   | `mcp__exarchos__`        |
| `COMMAND_PREFIX`            | `/exarchos:`                        | `` (empty)                            | varies                              | `/`                      |
| `TASK_TOOL`                 | `Task`                              | `spawn_agent`                         | varies                              | `task`                   |
| `CHAIN`                     | `Skill({ skill: "exarchos:..." })`  | bracketed prose                       | bracketed prose                     | bracketed prose          |
| `SPAWN_AGENT_CALL`          | full `Task({...})` block            | `spawn_agent({ ... })`                | runtime-native `Task({...})`        | `task --agent ...`       |
| `SUBAGENT_COMPLETION_HOOK`  | `TeammateIdle hook`                 | `subagent completion signal (poll-based)` | `subagent completion signal (poll-based)` | `subagent completion signal (poll-based)` |
| `SUBAGENT_RESULT_API`       | `TaskOutput({ task_id, block: true })` | `wait_agent({ task_id })`         | `[poll subagent result]`            | `` `task` output (inline) `` |

Reference a token in source via `{{TOKEN_NAME}}`. Renderer details:
- Multi-line values preserve the column of the opening `{{` on every
  subsequent line so visual indentation survives substitution.
- Tokens may carry args (`{{CHAIN next="plan" args="$PLAN"}}`); the
  args interpolate into the placeholder body via a nested pass.
- Unknown tokens fail the build with `unknown placeholder {{...}} in
  <file>:<line>`.

## Adding a new token

1. Add it to `RuntimeTokenKey` in `src/runtimes/types.ts`.
2. Add a value for that key under `placeholders:` in **every**
   `runtimes/*.yaml` file (six files).
3. Add it to `DEFAULT_PLACEHOLDER_VOCABULARY` in
   `src/placeholder-lint.ts` so the lint accepts source references.
4. Update this guide's table.

If a token cannot be defined sensibly for one runtime, **do not add
it**. Use a guard at the call site instead.

## `<!-- requires:* -->` guards

Wrap a block of prose in a guard to elide it on runtimes that lack a
specific capability. The capability identifier must be a member of
`SupportedCapabilityKey` in `src/runtimes/types.ts`; typos are build
errors with file/line.

### Plain guard — "any support"

```markdown
<!-- requires:team:agent-teams -->
... block included if the runtime declares `team:agent-teams`
    at any support level (`native` or `advisory`) ...
<!-- /requires -->
```

### Native guard — "native only"

```markdown
<!-- requires:native:session:resume -->
... block included only if `session:resume = native` ...
<!-- /requires -->
```

A capability that's `native` passes both forms. A capability that's
`advisory` passes the plain guard but fails the native variant. A
capability omitted from the runtime's `supportedCapabilities` map
fails both.

### Nesting

Nested guards are honored. If the outer guard fails, the inner block
is dropped wholesale regardless of the inner guard's evaluation. If
the outer passes, the inner is evaluated against the runtime in turn.

```markdown
<!-- requires:team:agent-teams -->
outer body
<!-- requires:fs:read -->
inner body — survives only when both outer and inner pass
<!-- /requires -->
outer trailer
<!-- /requires -->
```

### Reference-file pruning

After per-runtime rendering, the build scans the rendered SKILL.md
for `references/<file>` link targets and copies only the referenced
files (transitive closure across `references/**`). A reference file
linked exclusively from a guard-elided block does not appear in
runtimes where that guard fails.

To keep a reference file in every runtime's output, link to it from
prose **outside** any guard.
