# Design: Dual-Facade Skill Rendering (CLI vs. MCP)

**Status:** Draft
**Date:** 2026-04-14
**Feature ID:** `cli-vs-mcp-facade-analysis`
**Workflow:** feature

## Problem Statement

Exarchos ships two functional facades over a single execution core: an MCP server (4 composite tools + 1 hidden sync, over stdio) and a CLI (`exarchos <tool> <action> --flags`), both auto-generated from the same `TOOL_REGISTRY` via a shared `dispatch()` function. Skills are runtime-invariant Markdown with `{{TOKEN}}` placeholders rendered per runtime from `runtimes/<name>.yaml`. Today, rendered skills invoke the MCP facade in every runtime variant — including runtimes where MCP support is weak or absent. This creates three concrete problems:

1. **Context/token tax is paid uniformly.** MCP tool schemas live in the session system prompt whether the session uses them or not. Long-tail actions subsidize short sessions.
2. **Portability gap.** Runtimes without first-class MCP (anything rendered via `generic.yaml`, and in practice Copilot Chat contexts) have no working invocation path today — the CLI exists but skills don't target it.
3. **Positioning ambiguity for remote/hosted MCP.** "MCP" conflates two unrelated choices: *how an agent invokes an operation locally* vs. *where workflow state is deployed* (local SQLite vs. hosted service). The current architecture doesn't distinguish these axes.

Scope excludes: changes to the execution core, changes to the MCP tool surface, changes to the skill source-of-truth format beyond placeholder syntax.

## Options Considered

### Option 1: CLI-first for agents; MCP for external/centralized integrations

**Approach:** Skills render CLI invocations via `Bash` on every runtime. MCP continues to ship but is repositioned as the hosted/remote integration surface for dashboards and cross-project aggregation. Local agent workflows stop loading MCP tool schemas at session start.

**Pros:**
- Zero upfront token cost — no tool schemas in the system prompt.
- Maximum portability: works on any host with a shell.
- Humans can reproduce every agent action verbatim.

**Cons:**
- Process-start tax per call (~50–200ms SQLite init) accumulates in hot loops.
- Loses schema-guided call semantics — agents may guess arguments without running `exarchos schema`.
- Regression for MCP-native hosts (Claude Code), which amortize schema cost across long sessions.
- No streaming progress for long-running orchestrate actions.

**Best when:** The installed base is dominated by hosts with weak or absent MCP support, and token economy is the binding constraint.

### Option 2: MCP-first for agents; CLI as human/scripting escape hatch

**Approach:** Keep the status quo, refined. Skills render MCP tool calls uniformly. The CLI exists for humans, CI, and power-user scripting, but is not the primary agent surface. Remote MCP is deployable but not foregrounded.

**Pros:**
- Per-session schema amortization pays off in tool-heavy workflows (20–50+ calls is routine).
- Stateful MCP process warms SQLite, event store, and caches once.
- Native tool-use semantics on hosts optimized for them.
- Single rendering path — simplest test matrix.

**Cons:**
- Portability gap: runtimes without MCP are effectively second-class; `generic.yaml` has no working invocation path today.
- Upfront schema tax paid even in sessions that use the tools lightly.
- Conflates "MCP as invocation" with "MCP as deployment" — blurs remote-MCP narrative.
- Harder human reproduction of agent actions.

**Best when:** The installed base is dominated by MCP-native hosts and workflows are long enough to amortize schema cost.

### Option 3: Runtime-selected facade; remote MCP as a separate deployment axis (chosen)

**Approach:** The renderer selects per-runtime facade based on host capability declared in `runtimes/<name>.yaml`. Skill sources use a unified `{{CALL}}` macro; the renderer expands it to MCP tool_use or CLI `Bash` invocation. Remote/hosted MCP is lifted out of the facade discussion and scoped as a future deployment axis, orthogonal to how agents invoke operations locally.

**Pros:**
- Best-fit invocation per host: MCP-native runtimes amortize schemas; weak-MCP runtimes get a working path.
- Skill content stays invariant across runtimes (already true today).
- Parity-by-construction — both facades share one dispatch path and one registry.
- Cleanly separates the "how agents invoke" axis from the "where state lives" axis.

**Cons:**
- Doubles the rendered-output test matrix.
- Renderer gains a non-trivial macro parser.
- CLI-rendered path must achieve genuine parity (error shapes, progress, concurrency) — significant one-time work.
- Remote-MCP axis adds conceptual surface area to document even while deferred.

**Best when:** The installed base spans multiple runtimes with heterogeneous capabilities (current Exarchos reality — six runtime variants) and portability cannot be sacrificed to optimize the primary runtime.

## Chosen Approach

**Runtime-selected facade with remote MCP as a separate deployment axis (Option 3).**

The renderer already selects per-runtime placeholder values. We extend that mechanism so each runtime declares its **preferred invocation facade** (`mcp` or `cli`), and a unified `{{CALL tool action {...}}}` macro expands to the corresponding syntax — a tool_use block for MCP runtimes, a `Bash(exarchos … --json)` invocation for CLI runtimes. Skill source content remains invariant; only the placeholder branch changes. Remote/hosted MCP is lifted out of the facade discussion entirely and recorded as an aspirational third axis: a **deployment** choice about where state lives, orthogonal to how agents invoke operations.

**Rationale vs. alternatives:**
- *Option 1 (CLI-first everywhere)* sacrifices MCP's schema-guided call semantics and per-session state amortization on hosts that do support MCP well — a regression on the primary runtime (Claude Code).
- *Option 2 (MCP-first everywhere, status quo)* leaves the portability gap unaddressed and continues to muddle the local-vs-hosted distinction.
- *Option 3* accepts the cost of a dual rendering matrix in exchange for (a) best-fit invocation per host, (b) sharpened remote-MCP narrative, (c) parity-by-construction since both facades share one dispatch path.

**Scope discipline:** This design ships the facade-selection machinery, CLI rendering for weak-MCP runtimes, and the parity test harness. It explicitly does **not** implement remote MCP; that lands as a filed issue plus skeletal stubs for future work.

## Requirements

### DR-1: Runtime facade preference declaration

Each runtime map declares whether rendered skills should invoke operations via MCP tool calls or CLI `Bash` invocations. The declaration lives alongside existing capability flags in `runtimes/<name>.yaml`.

- **Acceptance criteria:**
- Given a runtime map at `runtimes/<name>.yaml`
  When the renderer reads it
  Then a required field `preferredFacade: "mcp" | "cli"` is present
  And the field is validated (renderer errors out if missing or malformed)
- Claude Code (`claude.yaml`) sets `preferredFacade: "mcp"` — no behavior change for the primary runtime.
- `generic.yaml` sets `preferredFacade: "cli"` — closes the portability gap for unknown hosts.
- A header comment in each runtime YAML justifies the choice (one or two lines referencing host capability).

### DR-2: Unified `{{CALL}}` placeholder macro

Skill sources express workflow invocations via a single runtime-agnostic macro. The renderer expands the macro into either an MCP tool_use form or a CLI `Bash` form based on the runtime's `preferredFacade`.

- **Acceptance criteria:**
- Given a skill source containing `{{CALL exarchos_workflow set {featureId: "X", phase: "plan"}}}`
  When rendered for a runtime with `preferredFacade: "mcp"`
  Then the output embeds an MCP tool_use invocation using that runtime's `mcpPrefix`
  And when rendered for a runtime with `preferredFacade: "cli"`
  Then the output embeds a `Bash` invocation of the form `exarchos workflow set --feature-id X --phase plan --json`
- The macro is the *only* sanctioned way to emit workflow invocations from skill sources. The vocabulary lint (`placeholder-lint.ts`) rejects raw `mcp__…` prefixes in skill sources after a migration window.
- `npm run skills:guard` fails on drift between `skills-src/` and rendered `skills/<runtime>/` output.
- Macro arguments are type-checked against the `TOOL_REGISTRY` schema at render time — a typo in `action` or an unknown flag errors the build.

### DR-3: CLI output parity with MCP

Every registered action exposes identical structured output across facades. CLI `--json` mode emits the same `ToolResult` shape that MCP returns as a tool_result payload; error shapes and exit codes align.

- **Acceptance criteria:**
- Given any `(tool, action)` pair in the `TOOL_REGISTRY`
  When invoked via `dispatch()` through the MCP adapter and via the CLI adapter with equivalent arguments and `--json`
  Then the returned JSON payloads are deep-equal (modulo non-deterministic fields like timestamps, which are normalized before comparison)
- CLI exit codes follow a domain-specific mapping adopted from the v3.0 roadmap (P1 [#1096](https://github.com/lvlup-sw/exarchos/issues/1096)): `0`=Success, `1`=GeneralError, `2`=GateFailed, `3`=InvalidInput, `4`=NotFound, `5`=PhaseViolation, `10`=StorageError, `15`=ConfigError, `17`=WaitTimeout, `18`=WaitFailed, `20`=ExportFailed. Codes 17/18/20 are forward-compatibility placeholders for v3.0 P4 lifecycle verbs. Documented in `adapters/cli.ts` header.
- Error payloads include `error.code` and `error.message` in both facades.
- A parity contract test sits next to each composite tool (`workflow.parity.test.ts`, `event.parity.test.ts`, `orchestrate.parity.test.ts`, `view.parity.test.ts`) and runs in CI.

### DR-4: End-to-end parity harness

A canonical workflow runs through both facades and produces byte-equivalent event-store state. This is a gate against subtle drift (handler order-of-effects, state merge semantics, event sequencing).

- **Acceptance criteria:**
- Given a fresh state directory
  When the harness executes a canonical `ideate → plan → delegate → review → synthesize` workflow via CLI-rendered invocations into a sandbox
  And executes the same workflow via MCP-rendered invocations into a sibling sandbox
  Then the resulting event-store JSONL files are identical (after normalizing timestamps and UUIDs)
  And the resulting SQLite snapshots match on all user-facing columns
- The harness runs in CI on every PR that touches `src/`, `adapters/`, `orchestrate/`, or `runtimes/`.
- Harness failure output shows the first diverging event with a rendered diff, not just "files differ."

### DR-5: Error handling, edge cases, and failure modes

The dual-facade mechanism must degrade predictably when a runtime's preferred facade is unavailable, when the CLI process-start path is stressed, or when long-running operations need progress signals. This requirement addresses the failure surface the migration introduces.

- **Acceptance criteria:**
- **Missing facade:** Given a runtime declares `preferredFacade: "mcp"` but the host lacks MCP support at session start, the rendered skill emits an actionable error referencing the install path (not silent failure, not a confusing tool-not-found).
- **Missing Bash tool:** Given a runtime declares `preferredFacade: "cli"` but the host's `Bash` tool is disabled or absent, the rendered skill emits an equivalent actionable error.
- **Process-start latency:** CLI path cold-start (SQLite init + backend wire-up) is measured in a benchmark (`bench/cli-startup.bench.ts`) and documented. Target: p95 under 250ms for no-op `exarchos workflow get --feature-id X`. Regressions fail CI.
- **Concurrent CLI invocations:** Given two concurrent `exarchos event append` invocations against the same `featureId`, they serialize via a file-lock or SQLite transaction discipline such that the resulting event-store remains consistent (no interleaved half-writes, no duplicate event sequences).
- **Long-running operations under CLI:** For any action flagged as long-running in the registry (primarily `orchestrate` subactions), the CLI path either streams line-buffered progress to stderr or explicitly documents that progress is not available — no silent hangs.
- **Argument coercion failure parity:** Given malformed arguments, both facades reject them with the same error code and equivalent message. Tested in `schema-to-flags.test.ts`.

### DR-6: Remote MCP deployment axis — ASPIRATIONAL, stubs only

Remote/hosted MCP is scoped out of this design's implementation. It is formalized as a future work item with placeholder interfaces and a tracking issue. **No implementation is expected in this cycle.**

- **Acceptance criteria:**
- A tracking issue is filed in the repo's issue tracker titled "Remote MCP deployment axis" with scope, non-goals, and decision criteria (authn model, multi-tenancy strategy, state backend, migration from local SQLite). **Filed: [lvlup-sw/exarchos#1081](https://github.com/lvlup-sw/exarchos/issues/1081).**
- A stub design document exists at `docs/designs/future/remote-mcp-deployment.md` with placeholder sections: Problem Statement, Deployment Model, Authn/Authz, Multi-Tenancy, State Storage, Migration Path, Open Questions. Each section marked `TODO`.
- A skeletal type stub exists in `servers/exarchos-mcp/src/adapters/remote-mcp.ts` with an exported `RemoteMcpAdapter` interface (method signatures only, no implementation; throws `NotImplementedError` at runtime). Gated behind `if (process.env.EXARCHOS_REMOTE_MCP === '1')` so it is unreachable in production paths.
- `CLAUDE.md` gains a one-line pointer under the architecture section: "Remote MCP is a future deployment axis — see `docs/designs/future/remote-mcp-deployment.md`."
- No tests are required for the stub; it is explicitly not a shipping capability.

### DR-7: Documentation and positioning

User-facing documentation reflects the three orthogonal axes (local CLI invocation, local MCP invocation, hosted MCP deployment) and gives installers a clear path to choose.

- **Acceptance criteria:**
- The `documentation/` VitePress site adds a page titled "Facade and Deployment Choices" with a 3x3 decision matrix (rows: host capability; columns: axes; cells: recommended configuration).
- `runtimes/<name>.yaml` header comments reference the docs page.
- The top-level README mentions that Exarchos supports both MCP-native hosts and CLI-only hosts; remote deployment is noted as future work.

### DR-8: Migration and backward compatibility

Shipping dual rendering must not regress existing Claude Code plugin installations or break skills in flight.

- **Acceptance criteria:**
- Given an existing Claude Code install running the pre-migration skill set
  When the migration ships
  Then all skills continue to function with zero user action (Claude Code runtime still renders to MCP invocations).
- The renderer supports a transition window where both raw `mcp__…` references and `{{CALL}}` macros are accepted in skill sources. After the window closes (tracked by a follow-up issue), the placeholder lint rejects the raw form.
- A `CHANGELOG.md` entry documents the new `preferredFacade` field and the CLI rendering path.

## Technical Design

### Architecture (current)

```
┌──────────────────────────────────────────────────┐
│                  TOOL_REGISTRY                   │
│       (one source of truth, Zod-typed)           │
└──────────────────┬───────────────────────────────┘
                   │
           ┌───────┴────────┐
           ▼                ▼
    ┌────────────┐   ┌────────────┐
    │ MCP adapter│   │ CLI adapter│   ◀─ both call dispatch()
    └─────┬──────┘   └─────┬──────┘
          │                │
          └────────┬───────┘
                   ▼
           ┌────────────────┐
           │   dispatch()   │ ◀─ DispatchContext (state dir, backend)
           └────────┬───────┘
                    ▼
           ┌─────────────────┐
           │ handlers        │
           │ (orchestrate,   │
           │  workflow,      │
           │  event, view)   │
           └─────────────────┘
```

### Architecture (target)

Same execution core. The change lands in the **renderer** (`src/build-skills.ts`) and the **runtime maps** (`runtimes/*.yaml`). Skill sources stop embedding facade-specific syntax.

```
skill source (invariant)
   │
   │    {{CALL exarchos_workflow set { … }}}
   ▼
renderer reads runtimes/<name>.yaml
   │
   ├─── preferredFacade: "mcp"  ──▶ mcp__plugin_exarchos_exarchos__exarchos_workflow({action:"set", …})
   │
   └─── preferredFacade: "cli"  ──▶ Bash: exarchos workflow set --feature-id X --phase plan --json
```

### Placeholder macro semantics

The `{{CALL tool action <json-args>}}` macro takes:
- `tool` — a composite tool name from the registry (e.g. `exarchos_workflow`).
- `action` — an action name within that tool.
- `<json-args>` — a JSON-ish literal; the renderer parses it, validates against the action's Zod schema, and rewrites into either the MCP tool_use payload or CLI flag form.

Validation happens at render time, not runtime. A typo in `action` or an unknown argument fails `npm run build:skills`.

### CLI rendering specifics

- Argument mapping: `camelCase` keys become `--kebab-case` flags (existing behavior in `schema-to-flags.ts`).
- Output capture: `--json` always appended; skills show the command and instruct the agent to parse stdout as JSON.
- Error handling: skills show the expected `error.code` values inline, matching the MCP error shape.

## Integration Points

- **`src/build-skills.ts`** — gains `{{CALL}}` macro parser and per-runtime rendering branch.
- **`src/placeholder-lint.ts`** — adds rejection rule for raw `mcp__…` prefixes (post-migration).
- **`runtimes/*.yaml`** — each file gains `preferredFacade` field.
- **`servers/exarchos-mcp/src/registry.ts`** — actions may opt into a `longRunning: true` flag (used by DR-5 for CLI progress discipline).
- **`servers/exarchos-mcp/src/adapters/cli.ts`** — minor: add exit-code mapping, concurrency lock, startup benchmark hook.
- **`servers/exarchos-mcp/src/adapters/remote-mcp.ts`** (new, stub per DR-6) — interface skeleton only.
- **`documentation/`** — new page per DR-7.

No changes to handlers, event store, or state-store semantics.

## Testing Strategy

- **Unit:** `{{CALL}}` macro parser, renderer per-runtime output, schema-to-flags coercion (existing tests extended).
- **Contract (DR-3):** per-action parity tests asserting `dispatch()` via each adapter yields equal `ToolResult` payloads.
- **End-to-end (DR-4):** parity harness runs a canonical workflow through both facades; compares event-store files.
- **Benchmark (DR-5):** CLI cold-start latency; fails CI on regression.
- **Concurrency (DR-5):** two CLI processes appending events to the same featureId concurrently must produce a consistent event store.
- **No new tests for DR-6** (stub only).

## Open Questions

1. **Macro syntax stability.** `{{CALL tool action {…}}}` uses JSON-ish argument blocks. Do we need a stricter grammar (e.g., YAML-style) or is JSON sufficient? Pending renderer prototype.
2. **Progress streaming for CLI long-running ops.** Line-buffered stderr is the minimum; do we also want a structured `--progress-fd` protocol for richer signaling? Defer to first concrete use case.
3. **Transition window length.** How long do we accept both `{{CALL}}` and raw `mcp__…` references in skill sources before the lint rejects the latter? Suggest: one minor version.
4. **`preferredFacade` granularity.** Is per-runtime sufficient, or do we need per-(runtime × action) overrides (e.g., a runtime prefers MCP but forces CLI for long-running orchestrate actions)? Start per-runtime; revisit if we observe need.
5. **Remote MCP decision criteria.** Tracked in the aspirational issue (DR-6); not resolved here.
