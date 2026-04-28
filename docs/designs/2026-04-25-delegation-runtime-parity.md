# Delegation Runtime Parity: A Capability-Based Adapter Layer for Multi-Runtime Subagent Dispatch

> **Status:** Design — `delegation-runtime-parity`
> **Date:** 2026-04-25
> **Workflow:** `/exarchos:ideate` → `/exarchos:plan`
> **Discovery:** [`2026-04-25-delegation-platform-agnosticity.md`](../research/2026-04-25-delegation-platform-agnosticity.md)
> **Marketing principle:** [`2026-04-25-marketing-positioning.md`](../research/2026-04-25-marketing-positioning.md) Principle 9

---

## 1. Problem statement

The discovery audit identified that Exarchos's `delegate` phase fails its platform-agnosticity claim against four of five Tier 1 runtimes. The leaks group into four classes:

1. **Generator gap** — `generate-cc-agents.ts` produces Claude-shaped agent definition files only; Codex/OpenCode/Cursor/Copilot have no equivalent.
2. **Wrong primitive (Copilot)** — `copilot.yaml` selects `/delegate` (async cloud worker) when the worktree fan-out pattern needs the local `task --agent` primitive.
3. **Stale capability claim (Cursor)** — `cursor.yaml` declares `hasSubagents: false`, written before Cursor 2.5 shipped native subagents in early 2026.
4. **Layer-B prose assumptions** — `skills-src/delegation/SKILL.md` and references encode Claude-only vocabulary (`TeammateIdle`, `SubagentStart`, `TaskOutput`, `SendMessage`, `TeamCreate`, Agent Teams mode, session resumption) as if universal.

The root cause is uniform: the spec registry, the generator, and the skill prose all use Claude infrastructure vocabulary as the canonical type. Every translation away from Claude leaks. This design replaces the canonical type with runtime-neutral capability vocabulary and re-grounds the generator and prose renderer on top of it. Pattern grounding: Hexagonal Architecture (Cockburn), Anti-Corruption Layer (Evans, via Microsoft Cloud Design Patterns), and the empirical proof point of LiteLLM's 100+-provider abstraction at scale.

---

## 2. Goals and non-goals

### Goals

- A single domain-language vocabulary for declaring agent capabilities, independent of any runtime's tool naming.
- One generator that produces correct agent definition files for all five Tier 1 runtimes.
- Skill prose that renders cleanly per-runtime, without "Claude-only" markers in the rendered artifact.
- Honest capability matrix in user-facing docs.
- Atomic landing — no transitional duplication, no Strangler Fig phasing in the merged artifact.

### Non-goals

- Remote MCP delegation (tracked separately at [`docs/designs/future/remote-mcp-deployment.md`](future/remote-mcp-deployment.md), [#1081](https://github.com/lvlup-sw/exarchos/issues/1081)).
- Adding new runtimes beyond the existing six (Claude, Codex, OpenCode, Cursor, Copilot, generic).
- Changing the `prepare_delegation`, `task_complete`, `check_tdd_compliance`, or convergence gate logic — those already audited as runtime-neutral.
- Changing the saga shape for Agent Teams mode where the runtime supports it. Agent Teams remains Claude-only by capability declaration; the design only changes how non-Claude runtimes encounter that section.

---

## 3. Capability vocabulary (domain layer)

The new domain type is a typed enum of capabilities declared by an agent spec. Capabilities are runtime-neutral verbs, drawn from the operational surface the four canonical agent specs (`implementer`, `fixer`, `reviewer`, `scaffolder`) actually require. Initial vocabulary:

| Capability | Meaning | Claude binding | Codex binding | OpenCode binding | Cursor binding | Copilot binding |
|---|---|---|---|---|---|---|
| `fs:read` | Read project files | `Read` | implicit (sandbox) | `tools.read: true` | implicit | implicit |
| `fs:write` | Modify project files | `Write`, `Edit` | implicit | `tools.write: true`, `tools.edit: true` | `readonly: false` | implicit |
| `shell:exec` | Run shell commands | `Bash` | `sandbox_mode` | `tools.bash: true` | implicit | implicit |
| `subagent:spawn` | Launch a subagent | `Task` | `spawn_agent` | `Task` (subagent_type) | `Task` | `task --agent` |
| `subagent:completion-signal` | Hook on subagent finish | `TeammateIdle` | (poll-based) | (poll-based) | (poll-based) | (poll-based) |
| `subagent:start-signal` | Hook on subagent start | `SubagentStart` | — | — | — | — |
| `mcp:exarchos` | Access Exarchos MCP server | `mcpServers: [exarchos]` | `mcp_servers` | `mcp` config | `mcpServers` | `mcp` config |
| `isolation:worktree` | Worktree-scoped execution | `isolation: worktree` | sandbox | (advisory) | `is_background` | (advisory) |
| `team:agent-teams` | Tmux-based parallel UI | `--mode agent-team` | — | — | — | — |
| `session:resume` | Resume by `agentId` | native | — | — | — | — |

Capabilities are encoded in `servers/exarchos-mcp/src/agents/capabilities.ts` as a Zod `z.enum([...])` of string-key capability identifiers. Agent specs in `definitions.ts` declare `capabilities: Capability[]`. The Claude tool array (`Read`, `Write`, etc.) disappears from the registry; it reappears only inside `adapters/claude.ts` during lowering. This is the dependency-direction inversion required by Hexagonal Architecture and the semantic-translation discipline required by ACL.

Each runtime declares `supportedCapabilities: Capability[]` in `runtimes/<name>.yaml`. A spec requiring `team:agent-teams` against a runtime that doesn't declare it produces a build-time error from the renderer, not a silent omission.

---

## 4. Adapter layer

Per-runtime adapters live in `servers/exarchos-mcp/src/agents/adapters/<runtime>.ts`. Each implements:

```typescript
interface RuntimeAdapter {
  runtime: Runtime;
  agentFilePath(agentName: string): string;
  lowerSpec(spec: AgentSpec): { path: string; contents: string };
  validateSupport(spec: AgentSpec): ValidationResult;
}
```

The `lowerSpec` method is the LiteLLM-style `transform_request` analog: it takes a domain object (capability-declared spec) and produces a runtime-shaped artifact (TOML for Codex, Markdown with `mode: subagent` for OpenCode, `.agent.md` for Copilot, `.cursor/agents/*.md` for Cursor, `agents/*.md` for Claude). Each adapter is responsible for its runtime's frontmatter shape, file extension, and capability lowering.

The five Tier 1 adapters:

- `claude.ts` — replaces `generate-cc-agents.ts`. Lowers capabilities into Claude's `tools` array, `hooks` block, `mcpServers` array, and `isolation` field. Output is byte-identical to the current `generate-cc-agents.ts` output for regression safety (verified by snapshot test).
- `codex.ts` — emits TOML at `~/.codex/agents/<name>.toml` with `developer_instructions` constructed from spec body + capability descriptions. Until upstream issues #15250 / #14579 resolve, the adapter ALSO renders a fallback `spawn_agent` invocation against `agent_type: "default"` with inlined prompt; the YAML's `SPAWN_AGENT_CALL` token chooses between them via a `codex.customAgentResolutionWorks: false` flag. When upstream fixes land, flip the flag.
- `opencode.ts` — emits Markdown at `~/.config/opencode/agents/<name>.md` with `mode: subagent`, boolean-map `tools`, `permission.task` filtering. Closes the broken `Task({subagent_type: ...})` reference identified in discovery §3.
- `cursor.ts` — emits Markdown at `.cursor/agents/<name>.md`. Honors Cursor 2.5 frontmatter (`model: inherit`, `readonly: false`, `is_background: false`). The `.claude/agents/` compatibility shim is documented as "discoverability only" in the README; we generate native `.cursor/agents/` for fidelity.
- `copilot.ts` — emits Markdown at `~/.copilot/agents/<name>.agent.md`. Switches `copilot.yaml`'s `SPAWN_AGENT_CALL` from `/delegate "..."` to `task --agent <name>` programmatic invocation.

Generic runtime has no adapter — sequential prose-degradation marker remains, sourced from `runtimes/generic.yaml`.

---

## 5. Composition root

`servers/exarchos-mcp/src/agents/generate-agents.ts` (singular) replaces `generate-cc-agents.ts`. It walks the `definitions.ts` registry, fans out across `RuntimeAdapter[]`, validates each spec against each runtime's `supportedCapabilities`, and writes per-runtime files. It also updates `.claude-plugin/plugin.json` (Claude only — that artifact is plugin-packaging-specific) and adds analogous registration files where the runtime requires them (`opencode/agents.json` if needed; Cursor and Codex pick up files by directory scan, no registration).

The renderer's failure modes are explicit: an unsupported capability is a build error, not a silent omission. A missing adapter is a build error. A spec that declares no capabilities is a build error.

`generate-cc-agents.ts` is deleted in the same change — DIM-5 hygiene, no divergent implementations. The `npm run build:skills` pipeline gains a `pre:` step that invokes `generate-agents.ts`. The `skills:guard` CI check extends to fail on `git diff agents/` drift in addition to `skills/`.

---

## 6. Prose layer — Layer-B detoxification

The skill source at `skills-src/delegation/SKILL.md` and its references stay unified (one source-of-truth). The renderer (`src/build-skills.ts`) gains two new mechanisms grounded in the capability vocabulary:

**Capability-tokenized terms.** Hook names and native API names become tokens resolved per runtime:

- `{{SUBAGENT_COMPLETION_HOOK}}` → `TeammateIdle hook` (Claude) / `subagent completion signal (poll-based)` (others)
- `{{TASK_LIST_API}}` → `TaskList tool` (Claude) / `(no native equivalent — see capability matrix)` (others)

**Capability-guarded sections.** Markdown blocks fenced with `<!-- requires:capability -->` markers render only when the runtime declares the capability:

```markdown
<!-- requires:team:agent-teams -->
### Agent Teams mode
[full Agent Teams content]
<!-- /requires -->
```

Non-supporting runtimes get the block elided entirely. The discovery's `references/agent-teams-saga.md` becomes a `<!-- requires:team:agent-teams -->`-guarded reference; on non-Claude renders it disappears from the skill output.

The vocabulary lint already in `build-skills.ts` extends to enforce: no Claude-specific term (`TeammateIdle`, `SubagentStart`, `TaskOutput`, `TaskList`, `TaskUpdate`, `SendMessage`, `TeamCreate`, `TeamDelete`, `agentId`, `agent-team`) appears in `skills-src/delegation/**` outside a `<!-- requires:* -->` guard or behind a token. Violations fail CI.

This satisfies DIM-3 (capability vocabulary is the contract between YAML and prose), DIM-6 (renderer is the prose adapter, mirroring the agent-spec adapter), and DIM-8 (rendered artifacts read as native to each runtime, no infrastructure-marker pollution).

---

## 7. Tier model and capability matrix

The README and runtime documentation move from "5 Tier 1 runtimes + generic" prose to a two-tier model with an explicit capability matrix:

- **Tier 1 (native subagent dispatch).** Claude Code, Codex CLI, OpenCode, Cursor, Copilot CLI. All have a generated agent definition file and a real spawn primitive. Differences in fidelity are documented per-capability, not per-tier.
- **Generic (sequential).** No spawn primitive assumed; orchestrator visits worktrees in sequence. Documented as graceful degradation, warned at delegation start.

The capability matrix becomes a user-facing artifact in the README, generated from `runtimes/<name>.yaml` `supportedCapabilities` declarations. Rows are runtimes, columns are capabilities, cells are ✓ / native primitive name / ✗. The matrix carries the nuance the prose used to bury (e.g., "Claude has `TeammateIdle`; everyone else polls"); the tier framing stays clean.

This intentionally retires the implicit privileged-Claude posture. Claude is one Tier 1 runtime among five — no more, no less.

---

## 8. Validation strategy

The design adds three validation layers, none of which exist today:

1. **Capability-registry typecheck.** `definitions.ts` and `capabilities.ts` are strict TypeScript with Zod schemas. A spec that declares an unknown capability fails `npm run typecheck`.
2. **Adapter validation.** Each `RuntimeAdapter.validateSupport(spec)` runs at generation time. An unsupported capability for a runtime raises a build error with a fix hint ("Spec implementer requires team:agent-teams; runtime opencode does not support it; either remove the capability or exclude opencode").
3. **Prose vocabulary lint.** Pre-flight check in `build-skills.ts` greps `skills-src/delegation/**` for Claude-specific terms outside guards. Fails CI on violation.
4. **Snapshot regression for Claude.** A snapshot test pins the current Claude agent files; the new `claude.ts` adapter must reproduce them byte-identically. This guarantees the atomic landing doesn't break the working Claude path.
5. **Smoke generation for each runtime.** `npm run generate:agents` produces all per-runtime files; CI asserts each file is well-formed (TOML parses, Markdown frontmatter validates against the runtime's expected schema).

No existing test in the workflow harness changes behavior. The convergence gates, event store, and state-machine projection are untouched.

---

## 9. Out of scope and follow-ups

- Codex upstream resolution (#15250, #14579). The adapter handles both states via the `customAgentResolutionWorks` flag; flipping it when upstream fixes land is a one-line change, not a redesign.
- Tier classification UX (README rewrite, capability matrix layout). Mechanically generated from this design's output; presentation work is a separate small task.
- Sequential-runtime UX improvements (Generic). Out of scope here; tracked as part of the broader runtime parity epic if pursued.
- Removing the `runtimes/` YAML system in favor of all-TypeScript registries. Not now — the YAML layer is the existing cross-skill abstraction and is working. Replacing it is a separate architectural decision.

---

## 10. Sources

### Pattern grounding (verified 2026-04-25)
- Cockburn, Hexagonal Architecture (Ports and Adapters) — synthesized via Ross Jr. (2026), Derzhavets (2026), TMS Outsource (2026), Hannen (2024)
- Evans, *Domain-Driven Design* — Anti-Corruption Layer pattern, Microsoft Azure Architecture Center: `https://learn.microsoft.com/azure/architecture/patterns/anti-corruption-layer`
- LiteLLM provider integration: `https://docs.litellm.ai/docs/provider_registration`
- LiteLLM analysis (Adapter as core pattern): `liyedanpdx/llm-python-patterns/cases_analysis/litellm_analysis.md`
- LiteObject/llm-provider-abstraction (Adapter + Factory reference)

### Quality grounding
- axiom backend-quality dimensions: DIM-1 Topology, DIM-3 Contracts, DIM-5 Hygiene, DIM-6 Architecture, DIM-8 Prose Quality (lvlup-sw/axiom v0.2.7 `skills/backend-quality/references/dimensions.md`)

### Internal
- Discovery: `docs/research/2026-04-25-delegation-platform-agnosticity.md`
- Marketing principle: `docs/research/2026-04-25-marketing-positioning.md` (Principle 9)
- Current generator: `servers/exarchos-mcp/src/agents/generate-cc-agents.ts`
- Current registry: `servers/exarchos-mcp/src/agents/definitions.ts`
- Current skill source: `skills-src/delegation/SKILL.md`
- Runtime YAMLs: `runtimes/{claude,codex,opencode,cursor,copilot,generic}.yaml`
