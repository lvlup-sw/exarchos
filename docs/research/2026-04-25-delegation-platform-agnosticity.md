# Delegation Platform-Agnosticity Audit: Where the Workflow Harness Is and Isn't Runtime-Neutral

> **Status:** Discovery — `delegation-platform-agnosticity`
> **Date:** 2026-04-25
> **Workflow:** `/exarchos:discover`
> **Scope:** Investigative only. Audits the current implementation of the `delegate` phase across the six runtime maps. No fix proposals — those belong in a follow-on `/exarchos:ideate`.
> **Related:** `2026-04-25-marketing-positioning.md` (positions Exarchos as runtime-agnostic; this doc audits whether that claim holds for the most leak-prone phase).

---

## 1. Why this research exists

A core marketing principle in `2026-04-25-marketing-positioning.md` (Principle 9) is that **Exarchos is a CLI that ships first-class plugin ergonomics for Claude Code and graceful degradation for everything else**. The README is being reordered to lead with platform-agnosticity and graceful-degradation language.

If that claim is going to scale to non-Claude readers, the implementation has to actually deliver it. The state machine, event log, gates, and `/rehydrate` all hold up — they operate on git history and structured state, not on a specific harness. The phase that does *not* obviously hold up is **delegation**: the moment Exarchos hands work to a sub-agent.

This audit traces what the delegation phase actually does on each of the six runtime maps Exarchos supports — Claude, Codex, OpenCode, Cursor, Copilot, generic — and identifies which parts of the abstraction hold, which parts leak, and what kind of leak each one is.

The conclusion is sharper than the original concern. The delegation phase **could be** largely runtime-neutral — every Tier 1 runtime now exposes a local subagent primitive. But Exarchos currently exploits only the Claude path properly, with three of four other Tier 1 runtimes pointing at undefined agent names, picking suboptimal primitives, or shipping stale capability claims.

---

## 2. The two-layer split

Delegation in Exarchos lives in two distinct layers, each with its own runtime story.

### Layer A — token-templated (mostly clean)

The skill source-of-truth at `skills-src/delegation/SKILL.md` is templated. Per-runtime values live in `runtimes/<name>.yaml` and are substituted by `src/build-skills.ts`:

- `{{COMMAND_PREFIX}}` — `/exarchos:` on Claude, `/` on OpenCode/Copilot, empty on Codex/Cursor/generic
- `{{TASK_TOOL}}` — `Task`, `spawn_agent`, `/delegate`, or a degraded prose marker
- `{{CHAIN}}` — Claude's `Skill({skill: "exarchos:next"})`, prose elsewhere
- `{{SPAWN_AGENT_CALL}}` — the rendered subagent dispatch

Layer A is the abstraction working as intended. The skill source is single-sourced, the YAMLs encode runtime divergence, the renderer fans out per-runtime variants. Skills source-of-truth lints clean against the controlled vocabulary.

### Layer B — prose-embedded (Claude-shaped)

Outside the templated tokens, the skill prose hard-codes Claude Code semantics as if they were universal:

- "On runtimes that support session resume (e.g. Claude Code with an `agentId` in workflow state)..." — only Claude has session resume
- "Auto-detection: tmux + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` present means `agent-team`" — Claude-only feature gating leaks into the universal source
- "Teammates visible in tmux split panes" — Claude Agent Teams only
- "`TeammateIdle` hook auto-runs quality gates" — Claude-only hook
- "`SubagentStart` hook injects live coordination data" — Claude-only hook
- `TaskOutput`, `TaskList`, `TaskUpdate`, `SendMessage`, `TeamCreate`, `TeamDelete` — Claude-only native APIs, referenced as the monitoring contract

`references/agent-teams-saga.md` is the strongest example: a 6-step saga whose every step assumes Claude Code's Agent Teams subsystem (tmux panes, `team_name` parameter, `TeammateIdle` lifecycle, `~/.claude/teams/{featureId}/config.json` on disk).

Layer B is where the platform-agnosticity claim breaks down today. The token system can't fix it because the prose isn't tokenized — it's narration about a specific runtime's capability surface.

---

## 3. Per-runtime audit

The following table is the corrected picture, after web-verification against current vendor documentation (April 2026).

| Runtime | Local subagent primitive | Custom-agent definition format | What Exarchos generates today | What the runtime YAML renders |
|---------|--------------------------|--------------------------------|-------------------------------|------------------------------|
| **Claude Code** | `Task` tool, `run_in_background: true`, parallel via single-message multi-tool-use | `agents/<name>.md` with rich frontmatter (tools, hooks, model, isolation, mcpServers, memory, skills) | Yes — `generate-cc-agents.ts` renders all four agent specs + updates `.claude-plugin/plugin.json` | `Task({subagent_type: "exarchos-implementer", ...})` ✓ resolves |
| **Codex CLI** | `spawn_agent` (multi_agents_v2), parallel via fan-out, batch via `spawn_agents_on_csv` | `~/.codex/agents/<name>.toml` or `.codex/agents/<name>.toml` (TOML, fields: `name`, `description`, `developer_instructions`, optional `model`/`reasoning_effort`/`sandbox_mode`/`mcp_servers`) | No | `spawn_agent({agent_type: "default", message: "<full prompt>"})` — uses built-in `default` role and inlines the prompt. Documented workaround for known bugs in custom-agent name resolution from tool-backed sessions (issues #15250, #14579). Works. |
| **OpenCode** | `Task` tool with `subagent_type` resolved against config; parallel via single-message multi-tool-use | `~/.config/opencode/agents/<name>.md` (or project `.opencode/agents/`) with `mode: subagent` frontmatter; tools as boolean object (`tools: { write: false }`); `permission.task` filtering | No | `Task({subagent_type: "exarchos-implementer", prompt: "<full prompt>"})` — references an agent name that doesn't exist on disk because Exarchos doesn't generate OpenCode-shape definitions. Behavior at runtime: OpenCode rejects the call, model retries, eventually escalates. **Likely broken in practice.** |
| **Cursor** | Native sub-agent spawning (Cursor 2.5+, shipped early 2026); `Task` tool; nested launches; parallel via single-message multi-tool-use | `.cursor/agents/<name>.md` (project) or `~/.cursor/agents/<name>.md` (user); also reads `.claude/agents/` and `.codex/agents/` for compatibility; YAML frontmatter (name, description, optional model: `fast`/`inherit`/`<model>`, `readonly`, `is_background`) | No | "Cursor CLI has no in-session subagent primitive. Execute each task sequentially…" — **claim is stale**. Native subagents shipped between when the YAML was written and now. |
| **Copilot CLI** | Local custom agents via `task` tool with `--agent <name>` programmatic flag; subagents have isolated context windows | `~/.copilot/agents/<name>.agent.md` (user), `.github/agents/<name>.agent.md` (repo), or org `.github-private/agents/` | No | `/delegate "..."` — **wrong primitive**. `/delegate` ships work asynchronously to GitHub Copilot Coding Agent in the cloud, opens a PR. The local `task`/custom-agent path was the right choice for worktree fan-out; the YAML's own comment notes "may be used by a future variant runtime map if in-session parallelism is ever preferred" — i.e., the wrong choice was knowingly made. |
| **Generic** | None assumed | N/A | N/A | Prose marker — "Execute each task sequentially in the current session, one at a time, against the prepared worktrees." — graceful degradation, documented, works |

---

## 4. Three classes of leak

The audit surfaces three distinct kinds of platform coupling. They are not the same shape and don't have the same fix shape either.

### Class 1 — Generator gap (4 of 5 Tier 1 runtimes)

`servers/exarchos-mcp/src/agents/generate-cc-agents.ts` (the "cc" prefix means "Claude Code") renders the four canonical agent specs (`implementer`, `fixer`, `reviewer`, `scaffolder`) into Markdown files at `agents/<id>.md` and registers them in `.claude-plugin/plugin.json`. There is no `generate-codex-agents.ts`, `generate-opencode-agents.ts`, `generate-cursor-agents.ts`, or `generate-copilot-agents.ts`.

Each non-Claude runtime has its own custom-agent format, none of which is structurally close to Claude's:

- **Codex** uses TOML with `developer_instructions` (a single string) instead of a Markdown body
- **OpenCode** uses Markdown with `mode: subagent` and tools as a boolean map, not an array
- **Copilot** uses Markdown with the literal `.agent.md` extension and a different field set
- **Cursor** uses Markdown with `model: fast/inherit`, `readonly: bool`, `is_background: bool` — none of which are in the Claude shape

The `IMPLEMENTER`/`FIXER`/`REVIEWER`/`SCAFFOLDER` specs in `definitions.ts` are stored in a structurally-Claude-shaped form (e.g., `tools: ['Read', 'Write', 'Edit', 'Bash', ...]` — those are Claude tool names). Even if a multi-runtime generator existed, the upstream registry would need to abstract over tool naming.

### Class 2 — Wrong primitive picked (Copilot)

Copilot CLI exposes two distinct delegation primitives:

1. `/delegate "..."` — asynchronously ships work to GitHub Copilot Coding Agent in the cloud, opens a PR
2. `task` tool with `--agent <name>` programmatic flag — locally spawns a custom agent in the current session, isolated context, returns results inline

Exarchos's worktree fan-out pattern requires (2) — the orchestrator needs to dispatch, monitor in-session, and collect results. The runtime YAML chose (1). The YAML's own header comment documents the choice and acknowledges it: "Why we pick /delegate over the `task` tool: Exarchos's worktree fan-out pattern is inherently async…"

This was a misread. The fan-out is async only in the sense that subagents run in parallel and the orchestrator polls — it is not async in the sense that work executes on a remote worker after the session ends. `/delegate` doesn't give the orchestrator results to feed into the convergence gates. It produces a PR, asynchronously, in a separate context.

### Class 3 — Stale capability claim (Cursor)

`runtimes/cursor.yaml` declares `hasSubagents: false` and renders `SPAWN_AGENT_CALL` as the prose-degradation marker:

```
Cursor CLI has no in-session subagent primitive. Execute each task sequentially
in the current session, visiting each worktree in turn. Emit a single warning
once per delegation batch so operators know they are not getting parallelism.
```

This was true when written. It stopped being true with Cursor 2.5 in early 2026. Cursor shipped:

- `.cursor/agents/<name>.md` definitions (project + user scope)
- A `Task` tool whose semantics match Claude's closely enough that the official `cursor-sub-agents` npm package was archived with a deprecation note: "Cursor now ships with first-class sub-agent support directly in the IDE. This tool is no longer needed."
- Compatibility shims that read `.claude/agents/` and `.codex/agents/` directly (more on this in §5)
- Nested subagent spawning ("Yes. Since Cursor 2.5, subagents can launch child subagents to create a tree of coordinated work")

The runtime YAML hasn't been refreshed. Exarchos is shipping graceful degradation against a runtime that no longer needs it.

### Class 4 — Layer-B prose assumptions (all non-Claude runtimes)

Distinct from the spawn-primitive layer, the skill prose contains hard-coded Claude semantics that don't render through the token system:

- **Hooks** — `TeammateIdle`, `SubagentStart`, `PostToolUse`, `Stop` are referenced by name throughout `skills-src/delegation/` as if all runtimes had them. They don't. Codex has different hooks; OpenCode has none in the relevant lifecycle slots; Cursor and Copilot have neither.
- **Native team APIs** — `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskOutput`, `SendMessage`, `TeamCreate`, `TeamDelete` are Claude Code only. The Agent Teams saga at `references/agent-teams-saga.md` assumes them throughout.
- **Agent Teams mode** — `--mode agent-team` requires `tmux` and the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` flag. Documented as auto-detected, but no runtime besides Claude can possibly hit the auto-detect path. The skill source still presents it as a generic option.
- **Session resumption for fixers** — "On runtimes that support session resume (e.g. Claude Code with an `agentId` in workflow state)…" — the prose acknowledges this is Claude-specific, but the recommended fixer flow downstream depends on it.

This isn't a generator gap or a wrong-primitive choice. It's the skill prose itself silently scoping its instructions to one runtime.

---

## 5. The Cursor compatibility shim

One implementation detail in Cursor's docs is interesting enough to call out separately. From `cursor.com/docs/subagents`:

> | Type | Location | Scope |
> |------|----------|-------|
> | Project subagents | `.cursor/agents/` | Current project only |
> | | `.claude/agents/` | Current project only (Claude compatibility) |
> | | `.codex/agents/` | Current project only (Codex compatibility) |

Cursor explicitly reads Claude-format and Codex-format agent definitions from their respective directories. That means **Exarchos's existing Claude-shaped agent files at `~/.claude/agents/` are already partially picked up by Cursor** — without any code change.

Two caveats:

1. The frontmatter shape differs. Claude's `tools: ["Read", "Write", ...]` and `hooks:` blocks are not part of the Cursor schema. Cursor's parser tolerates extra fields but doesn't act on them — so a Claude-format file loaded into Cursor would lose tool restrictions, lose hook wiring, and lose the validation rules.
2. Cursor doesn't enforce the same isolation guarantees (`isolation: worktree` is a Claude-only field).

So the shim is a free win for **discoverability** ("yes, the agent exists; it can be spawned by name") but not for **fidelity** ("the spawned agent has the same constraints as on Claude"). It's a partial bridge, not a full one.

---

## 6. Findings

The platform-agnosticity story for delegation has roughly the following shape today:

| Surface | Runtime-agnostic? | Notes |
|---------|-------------------|-------|
| Skill source-of-truth tokens | ✓ | Templated correctly via `runtimes/<name>.yaml` |
| Worktree provisioning (`prepare_delegation`) | ✓ | Pure git operations; no runtime assumption |
| Convergence gates (`check_tdd_compliance`, `task_complete`, `check_static_analysis`) | ✓ | Operate on diffs and event stream |
| Event log | ✓ | Identical across runtimes |
| Spawn primitive available on each Tier 1 runtime | ✓ | All 5 Tier 1 runtimes now have local subagent dispatch |
| Generic-runtime sequential fallback | ✓ | Documented, warned, works |
| Agent definition file format | ✗ | Generator emits Claude shape only |
| YAML primitive choice (Copilot) | ✗ | Picked async cloud `/delegate` over local `task` |
| YAML capability declaration (Cursor) | ✗ | Stale `hasSubagents: false` against a runtime that ships native subagents |
| Skill prose assumes Claude hooks | ✗ | `TeammateIdle`, `SubagentStart`, `PostToolUse` are not universal |
| Skill prose assumes Claude native team APIs | ✗ | `TaskOutput`/`TaskList`/`SendMessage`/`TeamCreate` are Claude-only |
| Agent Teams mode | ✗ | Wholly Claude-shaped (tmux + experimental flag) but presented as generic |
| Fixer session-resume flow | ✗ | Claude-only `agentId` field, presented as a runtime-conditional "if available" |

The honest summary:

> **Most of Exarchos is platform-agnostic. Delegation is the conspicuous exception.** The leaks are all *mechanical* — generator gaps, stale capability claims, wrong-primitive picks, prose that didn't get tokenized. None is *architectural* — the design accommodates platform-agnostic delegation; the implementation just hasn't followed through for the four non-Claude Tier 1 runtimes.

A reader who installs Exarchos against Claude Code gets the full system. A reader on Codex gets a working but degraded path that inlines prompts and loses the agent-spec abstraction. A reader on Cursor gets explicit graceful-degradation messaging in 2026 against a runtime that doesn't need it. A reader on OpenCode gets a `Task` call that points at an agent name that doesn't exist on disk, and the model retries until it gives up. A reader on Copilot gets `/delegate`, which is the wrong primitive entirely.

The marketing-positioning Principle 9 (lead with platform-agnosticity) survives this audit only because most of the harness is genuinely runtime-neutral. The delegate phase is the part that would not survive a careful non-Claude reader's first installation attempt.

---

## 7. Open questions for follow-on work

These are not in scope for this discovery — they belong in a `/exarchos:ideate` follow-on. Listed for triage only.

1. **Multi-runtime agent generator.** Is the right shape one `generate-agents.ts` that fans out per-runtime (analogous to `build-skills.ts`), or per-runtime sibling generators? The `definitions.ts` upstream registry would need to abstract over tool naming (`Read`/`Write`/`Edit`/`Bash` → runtime-specific equivalents) and over hook semantics.
2. **Copilot YAML correction.** Switch from `/delegate` to the local `task` tool with `--agent <name>`. This requires (1) — there's no point in the YAML if there's no Copilot-shaped agent file to point at.
3. **Cursor YAML refresh.** Set `hasSubagents: true`, render `SPAWN_AGENT_CALL` against the native `Task` tool, decide whether to lean on the `.claude/agents/` compatibility shim (cheap, partial fidelity) or generate full `.cursor/agents/` files (more work, full fidelity).
4. **OpenCode YAML — close the loop.** Either generate OpenCode-shape agents from the spec registry (preferred), or change the YAML to inline the full implementer prompt and use a built-in subagent like `general` (cheap but loses the spec abstraction).
5. **Layer-B prose detoxification.** Decide whether to (a) move all hook-specific and team-API-specific guidance behind a runtime conditional in the skill prose, (b) split the skill into `delegation-claude.md` / `delegation-cross-platform.md` sources, or (c) keep the unified source and accept that non-Claude readers will encounter Claude-only sections marked "Claude Code only."
6. **Stop calling Cursor a degraded runtime.** Once (3) lands, Cursor is Tier 1. The README's runtime matrix needs to reflect that.
7. **Codex custom-agent resolution.** Watch issues #15250 and #14579 — when fixed upstream, the YAML can switch from `agent_type: "default"` + inline prompt to `agent_type: "exarchos-implementer"` against a generated TOML file. Until then the current workaround is correct.
8. **Tier classification refresh.** The current "5 Tier 1, gracefully degrade for the rest" framing assumes parity that doesn't exist. Three tiers (Claude / others-with-spawn-primitive / sequential) reflect reality more honestly.

---

## 8. Sources

### Internal
- `runtimes/{claude,codex,opencode,cursor,copilot,generic}.yaml`
- `skills-src/delegation/SKILL.md`
- `skills-src/delegation/references/{implementer-prompt,agent-teams-saga,worked-example,workflow-steps,parallel-strategy}.md`
- `servers/exarchos-mcp/src/agents/{definitions,types,generate-cc-agents}.ts`
- `agents/{implementer,fixer,reviewer,scaffolder}.md`
- `.claude-plugin/plugin.json`
- `docs/research/2026-04-25-marketing-positioning.md` (Principle 9 — platform-agnosticity)

### Vendor documentation (verified 2026-04-25)
- Cursor — `https://cursor.com/docs/subagents` (native subagents, `.cursor/agents/`, Claude/Codex compatibility shim, Cursor 2.5)
- Codex — `https://developers.openai.com/codex/multi-agent` (TOML custom agents, `spawn_agent`, built-in `default`/`worker`/`explorer` roles, `spawn_agents_on_csv` batch)
- Copilot CLI — `https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli` (`.agent.md` format, `~/.copilot/agents/`, `--agent` flag, isolated subagent context)
- Copilot CLI — `https://docs.github.com/copilot/how-tos/copilot-cli/use-copilot-cli-agents/invoke-custom-agents` (slash-command, explicit, inferred, programmatic invocation)
- OpenCode — `https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/task.txt` (Task tool description with `subagent_type` resolved against config)
- OpenCode — `https://opencode.ubitools.com/agents/` (Markdown agents, `mode: subagent`, `permission.task` filtering, `hidden: true`)

### Issue trackers (failure modes)
- `openai/codex#15250` — custom agents in `.codex/agents/` not invocable by name from tool-backed sessions
- `openai/codex#14579` — project-local custom agent roles not loaded for `spawn_agent`
- `anomalyco/opencode#20059` — Task tool `subagent_type` historical hardcoding (resolved in current `task.ts`)
- `anomalyco/opencode#20804` — non-Claude models guess `agent_type`/`agent` instead of `subagent_type`
- `ralfboltshauser/cursor-sub-agents` archive note — confirms Cursor 2.5 native sub-agents superseded the deeplink workaround
