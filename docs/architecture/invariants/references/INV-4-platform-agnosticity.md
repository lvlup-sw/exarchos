# INV-4: Platform-Agnosticity (Conform-and-Shrink, Not an Unqualified Multi-Runtime Claim)

Authored content is emitted **ONCE** as a standard-conformant artifact wherever an open standard converged — Agent Skills (`SKILL.md`), AGENTS.md, and MCP — and each of the six first-class runtimes (Claude Code, Codex, Copilot, Cursor, OpenCode, generic) reads it natively. Per-runtime fan-out is **TECHNICAL DEBT, not the target architecture**: a thin shim survives only where NO standard exists, and every residual shim carries an owner, the capability reason it exists, and a retirement condition. The skills renderer + runtime YAML system is the implementation; conformance plus shim minimization — not render-parity across N runtime variants — is the design discipline this invariant enforces, because a byte-perfect per-harness render proves the artifacts match, not that the guarantee holds.

## Acceptance questions

1. Does the design tokenize Claude-specific text via `{{TOKEN}}` placeholders, or guard via `<!-- requires:* -->`?
2. Is every new token declared in all six `runtimes/*.yaml` files?
3. Are new capability identifiers members of `SupportedCapabilityKey` in `src/runtimes/types.ts`?
4. Does `npm run skills:guard` pass — generated `skills/` is in sync with `skills-src/`?

## Repo-grounded checks

- Source-of-truth edits go to `skills-src/<name>/SKILL.md`, never to `skills/<runtime>/**`. Direct edits to `skills/<runtime>/**` will fail the `skills:guard` CI check.
- Reference files (`skills-src/<skill>/references/*.md`) carry no YAML frontmatter (CLAUDE.md "Reference-file frontmatter" rule). Frontmatter is reserved for skill entry points (`SKILL.md`, `commands/*.md`, `rules/*.md`).
- Every Claude-flavored example has a tokenized rendering for non-Claude runtimes. The decision rule (per `skills-src/SKILL_AUTHORING.md`): tokenize when a sensible non-Claude rendering exists; guard otherwise.
- Tokens used in source must be declared in `RuntimeTokenKey` (`src/runtimes/types.ts`) AND have a value under `placeholders:` in every `runtimes/*.yaml` (six files). The build pre-flight `assertRuntimeTokenCoverage` fails with a single aggregated error if any runtime lacks any required token.
- Capability identifiers in `<!-- requires:* -->` guards must be members of `SupportedCapabilityKey`. Typos surface as build errors with file/line.

## Token vocabulary (current)

| Token | Claude | Codex | OpenCode/Cursor/Generic | Copilot |
|---|---|---|---|---|
| `MCP_PREFIX` | `mcp__plugin_exarchos_exarchos__` | `mcp__exarchos__` | `mcp__exarchos__` | `mcp__exarchos__` |
| `COMMAND_PREFIX` | `/exarchos:` | `` (empty) | varies | `/` |
| `TASK_TOOL` | `Task` | `spawn_agent` | varies | `task` |
| `CHAIN` | `Skill({ skill: "exarchos:..." })` | bracketed prose | bracketed prose | bracketed prose |
| `SPAWN_AGENT_CALL` | full `Task({...})` block | `spawn_agent({ ... })` | runtime-native `Task({...})` | `task --agent ...` |
| `SUBAGENT_COMPLETION_HOOK` | `TeammateIdle hook` | poll-based | poll-based | poll-based |
| `SUBAGENT_RESULT_API` | `TaskOutput({ task_id, block: true })` | `wait_agent({ task_id })` | `[poll subagent result]` | `` `task` output (inline) `` |

If a token cannot be defined sensibly for one runtime, **do not add it**. Use a guard at the call site instead.

> **v2.12.0-preview.1 (conform-and-shrink, #1602):** the ~13 *procedural* skills now render **once** to `skills/standard/<verb>/` using the qualified logical tool form (`exarchos:<tool>`) with **no** `MCP_PREFIX` / `COMMAND_PREFIX` — one artifact every Tier-1 harness reads natively (Agent Skills), so the placeholder-lint now *rejects* prefix tokens in procedural sources. The token table above therefore applies **only** to the 3 *orchestration* skills (`delegate`, `refactor`, `ideate`) whose `TASK_TOOL` / `SPAWN_AGENT_CALL` / `CHAIN` / `SUBAGENT_*` genuinely fork per harness and keep the per-runtime render. The consumer on-ramp is likewise runtime-neutral: one `binding/standard/block.md` served to every harness (no per-runtime prefix baking), inserted into the consumer's `AGENTS.md` as a managed block with a `CLAUDE.md` → own-line `@AGENTS.md` shim. Skill name = directory name = canonical verb across all six runtimes. See [`docs/specs/2026-07-04-harness-conform-and-shrink.md`](../../../specs/2026-07-04-harness-conform-and-shrink.md) (DR-1 · DR-2 · DR-3 · DR-5).

## Guard syntax

```markdown
<!-- requires:team:agent-teams -->
... block included if the runtime declares `team:agent-teams`
    at any support level (`native` or `advisory`) ...
<!-- /requires -->

<!-- requires:native:session:resume -->
... block included only if `session:resume = native` ...
<!-- /requires -->
```

A capability that's `native` passes both forms. A capability that's `advisory` passes the plain guard but fails the native variant. A capability omitted from the runtime's `supportedCapabilities` map fails both.

## External grounding

- AgentPatterns [*MCP Client Design*](https://agentpatterns.ai/tool-engineering/mcp-client-design/) — namespace by server ID; per-request timeouts; graceful degradation on capability gaps.
- WebMCP [*Tool Design*](https://docs.mcp-b.ai/explanation/design/tool-design) — schemas are the type signature; constrain via enum/format, not free-text.
- `skills-src/SKILL_AUTHORING.md` — the authoritative authoring guide for tokens and guards.

## Severity guide

- **HIGH:** hardcoded Claude-only feature reference in `skills-src/` (e.g., `Skill({...})` syntax in source instead of `{{CHAIN}}`); direct edit to `skills/<runtime>/**` files; new capability identifier not in `SupportedCapabilityKey`.
- **MEDIUM:** missing token coverage for one runtime — caught by `assertRuntimeTokenCoverage` pre-flight; reference file carrying YAML frontmatter; new token declared in source but missing from one or more `runtimes/*.yaml`.
- **LOW:** stylistic Claude-isms in prose (e.g., "TaskCreate" verbatim where `{{TASK_TOOL}}` would render correctly); reference file linked exclusively from a guard-elided block (which means it won't ship to runtimes that fail the guard — usually intended, but worth flagging for visibility).

## Worked example

**Violation (HIGH):** Claude-flavored chain in source:

```markdown
<!-- skills-src/foo/SKILL.md — DON'T -->
After completing the analysis, invoke `Skill({ skill: "exarchos:plan", args: "..." })`.
```

Codex / Copilot / Cursor / OpenCode don't have `Skill({...})`. This source survives only because the renderer happens to copy verbatim — it's a token bypass.

**Fix:** Use the `CHAIN` token:

```markdown
<!-- skills-src/foo/SKILL.md — DO -->
After completing the analysis, {{CHAIN next="plan" args="..."}}.
```

The renderer substitutes per-runtime: `Skill({ skill: "exarchos:plan", args: "..." })` for Claude, bracketed prose for non-Claude harnesses.

**Violation (MEDIUM):** Reference file with frontmatter:

```markdown
<!-- skills-src/foo/references/bar.md — DON'T -->
---
title: Bar Reference
---

# Bar Reference

...
```

The `skills:guard` validator complains spuriously because reference files are includes, not skill entry points.

**Fix:** Remove the frontmatter. Use the first H1 heading for the title.

## See also

- Deterministic checks for INV-4 → [deterministic-checks.md](deterministic-checks.md#inv-4-platform-agnosticity)
- `skills-src/SKILL_AUTHORING.md` — full authoring guide
- [INV-3](INV-3-basileus-forward.md) — the resolver enforces capability-aware behavior at runtime; INV-4 enforces it at design-time
