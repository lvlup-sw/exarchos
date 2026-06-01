# Cross-Harness Exarchos Binding via Session Lifecycle Hooks

**Issue:** #1485 — *SessionStart binding hook (observe-only) + decide SessionEnd transcript-capture fate*
**Milestone:** v2.10.1 (milestone 17, sole remaining open item)
**Status:** Design — auto-chaining to `/exarchos:plan`
**Feature ID:** `session-lifecycle-hooks`
**ADR spine:** `docs/adrs/2026-05-24-hook-layer-observe-only.md` (hooks are observe-only; enforcement lives in the runtime-agnostic MCP tools)

**Decisions locked during ideation:**

- **(b) SessionEnd transcript capture → KEEP**, repurposed as the *instrument* that proves the binding works (native-vs-`mcp_exarchos` tool attribution).
- **(a) SessionStart → inject orientation context + emit a `session.started` event** (one hook, both jobs).
- **Cross-harness scope:** universal `AGENTS.md` binding for **all 6 runtimes**; **active lifecycle artifacts** rendered now for **Claude + Codex + opencode**; Cursor/Copilot active hooks *modeled but deferred* behind the same source-of-truth.
- **Consumer-project install** of the binding block is **deferred to the v2.10.2 `onboard` verb** (`docs/designs/2026-05-31-onboard-doctor-consolidation.md`), which already owns consumer-file mutation. #1485 ships the source-of-truth, renderer, and generated artifacts only.

---

## 1. Problem & Context

#1485 asks for two observe-only refinements layered on the #1483 hook spine: (a) a `SessionStart` hook that soft-binds the harness to route SDLC through Exarchos, and (b) a keep/cut decision on `SessionEnd` transcript capture. The reframe from ideation widened the scope along two axes the original issue under-specified:

1. **Cross-harness parity (INV-4).** A Claude-only `SessionStart` hook binds exactly one of six runtimes. The binding guarantee must exist on *every* runtime's path, not just Claude's native one. The cross-runtime equivalent of "inject orientation at session start" is, for most harnesses, an always-loaded instructions file — `AGENTS.md`.
2. **Minimal, dead-code-free hook surface.** The intent is that the *only* lifecycle hooks Exarchos ships are the ones backing `SessionStart` + `SessionEnd`. Everything else in the hook layer is pruned.

**Research finding that overturns the current model.** The runtime catalog declares `hasHooks: false` for codex/cursor/copilot/opencode. As of late-2025/early-2026 this is **stale**: every Tier-1 runtime now ships lifecycle hooks *and* reads an always-loaded instructions file. The capability model, the `HOOKS.md` "this runtime does not support hooks" stubs, and the Claude-only rendering are all out of date. See the capability matrix in §7.

**Current hook-layer state** (`hooks-src/hooks.json`): two hooks — `SubagentStop` (→ `exarchos subagent-stop`) and `SessionEnd` (→ `exarchos session-end`). Recon verdict: `SessionEnd` is genuinely live (feeds `session-provenance-projection` and the `exarchos_view session_provenance` action); **`SubagentStop` is live-but-unused** — it fires, the handler returns `{observed: true}`, and *nothing consumes the output*. `SessionStart` previously existed and was deliberately deleted in the T-40 auto-resume refactor because it drove implicit rehydration — so re-adding it must be observe-only orientation, never auto-rehydration.

## 2. Goals & Non-Goals

**Goals**
- One canonical **binding directive** (source of truth) rendered to every runtime's appropriate surface — the same facade/parity pattern as `build-skills`/`build-hooks`.
- **Universal binding** via `AGENTS.md` (and `CLAUDE.md` for Claude) on all 6 runtimes — the floor that works even where hooks cannot inject (Copilot, opencode, generic).
- **Active reinforcement + telemetry** where the runtime supports it: a `SessionStart`-class hook that injects the directive *and* emits `session.started`.
- A **closed observe-loop**: `session.started` (binding fired) → `SessionEnd` provenance (`native` vs `mcp_exarchos` tool mix) → measurable proof the binding shifts behavior.
- **Prune the hook surface** to `SessionStart` + `SessionEnd` only; delete `SubagentStop` and all dead/legacy hook code; correct the stale capability model.

**Non-Goals (explicit)**
- **No enforcement.** "Bind/enforce the harness" means strong, deterministic *orientation*, never action-blocking. Hooks stay fail-open per the ADR. No `PreToolUse` proxy, no phase/guard at the hook layer.
- **No auto-rehydration.** `SessionStart` must not drive state transitions or implicit resume (the T-40 trap). Recovery stays sourced entirely from the event store via explicit `/rehydrate`.
- **No consumer-file mutation in #1485.** Writing the binding block into a user's project is the v2.10.2 `onboard` verb's job.
- **No cross-runtime provenance parser parity** (deferred — see §6, §8).

## 3. Constraints (Invariants)

| Invariant | Bearing on this design |
|---|---|
| **INV-4** platform-agnosticity | The binding guarantee must hold on every runtime's path. Achieved via the universal `AGENTS.md` floor; the renderer branches on a **declared hook-capability profile**, never on a runtime-name literal. |
| **INV-2** facade-equivalence | `exarchos session-start` (new) carries behavior in the shared dispatch core; the hook/plugin is a thin invoker. CLI/MCP stay parity-equivalent; a registered `outputSchema` covers the verb. |
| **INV-1** event-sourcing-integrity | `session.started` is an append-only record in the per-session events log; the provenance projection stays a pure left-fold over it. No side database, no in-place mutation. |
| **INV-6** workload-agnosticism | `SessionStart` fires before any workflow type is known; the injected directive must not assume a workflow type. |
| **INV-11** posture-declared-capabilities | Observe-only/fail-open is unrepresentable-as-enforcement by construction — exactly the stated non-goal. opencode's plugin *cannot* inject, which makes its observe-only posture structural. |

## 4. Design — Binding Source of Truth & Multi-Surface Renderer

### 4.1 The binding directive (single source of truth)

A new source file — `binding-src/binding.md` (mirroring `hooks-src/`) — holds the canonical orientation text with `{{TOKEN}}` placeholders (`{{MCP_PREFIX}}`, `{{COMMAND_PREFIX}}`):

> *This project uses **Exarchos** for SDLC/process management. Route workflow operations through the `{{MCP_PREFIX}}exarchos_*` MCP tools (or the `{{COMMAND_PREFIX}}` workflow commands). Do not improvise process state — `exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, and `exarchos_view` are the source of truth.*

This is the one place the directive is authored. Every surface below is a *render* of it — changing the directive changes Claude's `additionalContext`, the `AGENTS.md` block, and Codex's hook identically. This upholds INV-2/INV-4: zero behavior in the surfaces, one canonical core.

### 4.2 Per-runtime surface matrix

Two orthogonal capabilities: **binding** (can we inject orientation?) and **telemetry** (can we observe start/end?).

| Runtime | Binding surface (orientation) | Active telemetry artifact (start/end) | Rendered in #1485? |
|---|---|---|---|
| **Claude** | `SessionStart` hook `additionalContext` + `CLAUDE.md` block | `SessionStart` + `SessionEnd` hooks | ✅ |
| **Codex** | `SessionStart` hook `additionalContext` + `AGENTS.md` block | `SessionStart` hook (+ `Stop`, best-effort) | ✅ |
| **opencode** | `AGENTS.md` block *(plugin cannot inject)* | TS plugin: `session.created` start telemetry (`session.idle`/end deferred — §8) | ✅ |
| **Cursor** | `AGENTS.md` block *(hook injection deferred)* | `sessionStart`/`sessionEnd` — **modeled, deferred** | ⏸ data only |
| **Copilot** | `AGENTS.md` block *(hook cannot inject)* | `sessionStart`/`sessionEnd` telemetry — **deferred** | ⏸ data only |
| **generic** | `AGENTS.md` block | — (no hook system) | ✅ (AGENTS.md) |

Key consequence: **every runtime is bound** (the `AGENTS.md`/`CLAUDE.md` floor is universal), while *active* lifecycle artifacts ship for the three the user prioritized. Cursor/Copilot are *modeled* now (capability data present) so adding their renderers later is a pure data+template change, not a re-architecture.

### 4.3 Hook-capability model (replaces the `hasHooks` boolean)

A boolean cannot express four divergent hook schemas + one plugin paradigm + injection capability. Replace `capabilities.hasHooks: bool` with a structured descriptor in each `runtimes/<name>.yaml`:

```yaml
capabilities:
  hooks:
    profile: claude-json | cursor-json | copilot-json | opencode-plugin | none
    canInjectContext: true | false        # SessionStart can return additionalContext?
    sessionStartEvent: SessionStart | sessionStart | session.created | null
    sessionEndEvent:   SessionEnd | Stop | sessionEnd | session.idle | null
```

- Claude → `{profile: claude-json, canInjectContext: true, start: SessionStart, end: SessionEnd}`
- Codex → `{profile: claude-json, canInjectContext: true, start: SessionStart, end: Stop}` *(Claude-schema-compatible — reuses the existing template ~verbatim with `{{MCP_PREFIX}}` swapped)*
- opencode → `{profile: opencode-plugin, canInjectContext: false, start: session.created, end: session.idle}`
- cursor → `{profile: cursor-json, canInjectContext: true, …}` *(renderer deferred)*
- copilot → `{profile: copilot-json, canInjectContext: false, …}` *(renderer deferred)*
- generic → `{profile: none, canInjectContext: false}`

The renderer dispatches on `profile`; an unimplemented profile (`cursor-json`, `copilot-json`) emits only the `AGENTS.md` block plus a *corrected* `HOOKS.md` note ("your runtime supports hooks — Exarchos renders them in a future release; the `AGENTS.md` binding is active now"). No runtime-name branching anywhere (INV-4).

### 4.4 The renderer (`build-binding`, evolved from `build-hooks`)

`buildAllHooks` generalizes into a binding renderer that, per runtime, emits:

1. **The `AGENTS.md`/`CLAUDE.md` binding block** — a marker-fenced region (`<!-- exarchos:binding:start --> … <!-- exarchos:binding:end -->`) so it is idempotently re-renderable and, later, mergeable into a consumer file without clobbering surrounding content.
2. **The active artifact**, dispatched on `hooks.profile`:
   - `claude-json` → `hooks.json` (Claude lands at `hooks/hooks.json` plugin path; Codex at `hooks/codex/hooks.json`).
   - `opencode-plugin` → a TS plugin at `hooks/opencode/plugin/exarchos-lifecycle.ts` subscribing to `session.created`/`session.idle`.
   - `none` / deferred → corrected `HOOKS.md` note only.

Drift-guarded exactly like skills: `npm run binding:guard` re-renders and fails CI on any `git diff`. Vocabulary lint runs pre-flight.

### 4.5 The closed observe-loop

```
 SessionStart (Claude/Codex hook;  opencode session.created)
     │  inject {{binding directive}}  ── Claude/Codex only (additionalContext)
     │  exec `exarchos session-start` ── appends `session.started` to
     │                                    sessions/<id>.events.jsonl
     ▼
 … agent works the session, ideally via exarchos_* tools …
     ▼
 SessionEnd (Claude hook;  opencode session.idle)
        exec `exarchos session-end` ── parses transcript → sessions/<id>.events.jsonl
                                        + manifest completion
     ▼
 session-provenance-projection  (pure left-fold)
        toolsByCategory: { native, mcp_exarchos, mcp_other }
     ▼
 exarchos_view session_provenance  ── the metric that PROVES the binding shifted behavior
```

`exarchos session-start` is a new hook-CLI observer (the same shape as `session-end`; not an MCP action — INV-2 governs MCP-visible verbs only): it (1) records a `session.started` entry — `{sessionId, startedAt, cwd, branch, workflowId?}` — via the **existing-but-unwired** `writeManifestEntry` (`session/manifest.ts`) into `manifest.jsonl`, and (2) prints the rendered directive as `additionalContext` for injection-capable hosts (Claude/Codex). The provenance projection already reads manifest entries (`readManifestEntries`), so this lights up dormant plumbing and keeps the projection a pure left-fold (INV-1).

> **Surface note (idempotency):** `session.started` must NOT be written to `sessions/<id>.events.jsonl` — that file is `session-end`'s idempotency sentinel (`session-end.ts:79` early-returns if it exists). Writing it at start would make `session-end` skip transcript parsing and break provenance. The manifest entry (`manifest.jsonl`) is the correct, separate start-record surface. The session-telemetry stream stays deliberately *separate* from the authoritative SQLite workflow event store.

## 5. Dead-Code Prune (the "no legacy hooks" requirement)

| Item | Verdict | Action |
|---|---|---|
| `SubagentStop` hook + `cli-commands/subagent-stop.ts` + its test | live-but-**unused** (no consumer) | **Delete** hook entry, handler, test; drop from `adapters/hooks.ts` `HOOK_COMMANDS`; drop registry registration. |
| `hasHooks: false` flags on codex/cursor/copilot/opencode | **stale/false** | Replace with the §4.3 `hooks` descriptor (all now support hooks). |
| `HOOKS.md` "does not support hooks" stubs | **stale/false** | Regenerate: rendered hook for implemented profiles; corrected note for deferred ones. |
| `agents/adapters/claude.ts` `PreToolUse` `pre-write`/`pre-edit` trigger mappings | recon: "defined but unused by any shipped agent" | **Prune candidate — verify in plan.** Agent-layer, not session-layer; confirm zero shipped-agent references before removal. |
| `agents` `PostToolUse` → `exarchos run-tests` | **live & functional** (TDD test gate) | **Keep.** Agent-spec hook, distinct from the session lifecycle layer; out of #1485 scope. |

Net hook-layer after #1485: **`SessionStart` + `SessionEnd` only.** SubagentStop gone; all removed enforcement hooks (guard/task-gate/teammate-gate/subagent-context, already deleted in #1476) confirmed absent.

## 6. (b) SessionEnd Decision — KEEP, as the instrument

`SessionEnd` transcript capture is **retained** and recorded as the decision for #1485(b). Rationale: it is the *only* mechanism that measures `native` vs `mcp_exarchos` tool usage per session, which is precisely how (a)'s binding is proven to work — the observability counterpart to the binding goal. It remains decoupled from rehydration/recovery (those are SQLite-sourced), so keeping it adds no recovery risk.

**Honest scope boundary:** the provenance *roll-up* parses the Claude transcript format. Codex/opencode `session-end`-equivalents will emit lifecycle events, but feeding their (differently-shaped) transcripts into the unified `toolsByCategory` roll-up needs **per-runtime parsers** — explicitly **deferred** to a follow-up. So in v2.10.1 the *binding* reaches parity across runtimes; the *measurement* is Claude-first with a clear extension path. This asymmetry is acceptable because provenance is an observability concern, not a substrate guarantee (INV-4 governs the binding, which does reach parity).

## 7. Cross-Harness Capability Research (appendix)

| Runtime | SessionStart-equiv | Inject context? | Config surface | Always-loaded instructions | SessionEnd-equiv |
|---|---|---|---|---|---|
| Claude | `SessionStart` | ✅ `additionalContext` | `hooks.json` | `CLAUDE.md` | `SessionEnd` |
| Codex | `SessionStart` | ✅ `additionalContext` (text or JSON) | `hooks.json` **or** `config.toml [[hooks.SessionStart]]` — Claude-compatible schema | `AGENTS.md` (`project_doc`) | `Stop` / `PreCompact` |
| Cursor | `sessionStart` | ✅ `additional_context` (snake) | `.cursor/hooks.json` (flat, camelCase) | `.cursor/rules` + `AGENTS.md` | `sessionEnd` |
| Copilot | `sessionStart` | ❌ side-effect only | `.github/hooks/`, `version:1`, `bash`/`powershell` | `AGENTS.md` / `.github/copilot-instructions.md` | `sessionEnd` |
| opencode | `session.created` | ❌ (plugins react, don't inject) | TS plugin in `.opencode/plugin/` | `AGENTS.md` (`/init`) | `session.idle` |
| generic | — | ❌ | — | `AGENTS.md` | — |

Sources: [Codex hooks](https://developers.openai.com/codex/hooks), [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md), [Cursor hooks](https://cursor.com/docs/hooks), [Copilot CLI hooks](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks), [Copilot custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions), [opencode plugins](https://opencode.ai/docs/plugins/).

## 8. Risks & Follow-Ups

- **opencode plugin cannot inject** → binding relies on `AGENTS.md` there; the plugin is telemetry-only. Acceptable (observe-only posture is structural). The exact session-`idle`-as-session-end semantics should be pinned in the plan (idle ≠ end; may fire repeatedly).
- **Codex has no clean SessionEnd** (`Stop` is per-turn). Codex ships SessionStart-active binding now; its session-end telemetry is best-effort/deferred.
- **Renderer divergence.** `claude-json` (Claude+Codex) + `opencode-plugin` are implemented; `cursor-json`/`copilot-json` are modeled-but-deferred. Tracked as a follow-up to complete active-hook parity.
- **Cross-runtime provenance parsers** — follow-up issue (own scope).
- **Milestone coupling.** Consumer install lands in v2.10.2 `onboard`; #1485 must leave a clean, documented renderer + marker-fenced artifact for `onboard` to consume.

## 9. Definition of Done (maps to #1485 acceptance)

- [ ] **(b) decision recorded:** keep `SessionEnd` transcript capture as provenance telemetry (this doc, §6).
- [ ] Binding-directive SoT (`binding-src/binding.md`) + renderer + `binding:guard` CI check.
- [ ] `SessionStart` observe-only hook for **Claude + Codex** (inject directive + emit `session.started`); fail-open; no enforcement; no auto-rehydration.
- [ ] **opencode** TS lifecycle plugin emitting `session.created` **start** telemetry. The `session.idle`→session-end branch is **deferred** (idle ≠ a clean end; may fire repeatedly; session-end's transcript parser is Claude-specific — see §8). The descriptor records `session.idle` as opencode's true end-event capability for when the cross-runtime provenance follow-up lands.
- [ ] Universal `AGENTS.md`/`CLAUDE.md` binding block rendered for all 6 runtimes (artifact only; consumer-install deferred).
- [ ] `SubagentStop` + dead hook code removed; stale `hasHooks` model replaced with the `hooks` descriptor; `HOOKS.md` stubs corrected.
- [ ] New `exarchos session-start` verb with registered `outputSchema`; CLI/MCP parity.
- [ ] `binding:guard` / `skills:guard` / `hooks:guard` green; no drift.
