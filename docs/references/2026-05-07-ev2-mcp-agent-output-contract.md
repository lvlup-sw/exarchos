# ev2-mcp agent output contract — recommendations

**Status:** recommendations (pending team review of decision points in §6)
**Date:** 2026-05-07
**Audience:** ev2-mcp maintainers and reviewers
**Scope:** `src/tools/ev2-mcp/`
**Supersedes:**
[`docs/research/2026-05-07-exarchos-m16-patterns-spike.md`](../research/2026-05-07-exarchos-m16-patterns-spike.md),
[`docs/research/2026-05-07-mcp-protocol-conformance.md`](../research/2026-05-07-mcp-protocol-conformance.md)
(both preserved as supporting analysis).

## TL;DR

ev2-mcp ships a stateless TypeScript MCP server / CLI that wraps `ev2.exe`.
Two research spikes (Exarchos milestone-16 patterns, MCP 2025-11-25
conformance) converged on a single set of recommendations. The biggest
single move: **stop inventing protocol shapes — adopt what the MCP 2025-11-25
spec already gives us.**

The recommendations split into five tracks:

1. **Foundation (one change, prerequisite for nine others):** redesign
   `ActionResult` to preserve structured handler data. Today's
   wrapper layer collapses rich objects (e.g. `handleRolloutMonitor`'s
   seven structured fields) into a single `result.message` string.
   Without this, every other recommendation that touches output is
   decorative.

2. **Cheap correctness wins, no foundation needed:** add Windows to the
   CI matrix; register `ev2_geneva` in the CLI (it ships in MCP only
   today).

3. **Adopt-now, after foundation:** `outputSchema` + `structuredContent`,
   tool annotations, per-call `_meta.guards`/`_meta.operationId`
   observability, MCP Roots for `serviceGroupRoot` autodetection.

4. **Adopt with experimental-API risk acceptance:** **Tasks (SEP-1686)**
   for `rollout monitor`. Both SDKs mark it experimental, but it is
   the spec-native answer to long-running deployment polling and it
   retires the parent spike's NDJSON-streaming design entirely.

5. **Adopt selectively or defer:** typed `next_actions` from errors and
   guards (not prose); MCP Resources for Ev2 docs; Elicitation for
   `INVALID_INPUT` and `AUTH_FAILED` flows; output-size truncation
   for `validate`/`lint`.

Three patterns explicitly **dropped** during the synthesis:

- **HATEOAS envelope as a literal JSON-in-text wrapper** — the parent
  spike's original §1. MCP's `structuredContent` carries the envelope
  natively; we don't stuff JSON inside `content[0].text`.
- **NDJSON streaming for `--follow`** — the parent spike's original §4.
  Tasks does this better, with capability negotiation built in.
- **Sampling, Prompts, Pre-Tasks Progress notifications** — not
  applicable to ev2-mcp. Documented for the record.

## 1. Findings

### F1. The current `ActionResult` pipeline is too lossy to wrap in any envelope

Today's pipeline at the dispatch boundary is:

```ts
// src/types.ts
export type ActionResult = string | { text: string; isError: boolean };
```

`handleRolloutMonitor` (`src/tools/rollout.ts:430+`) returns
`{ rolloutId, portalUrl, overallStatus, errorCode, errorMessage, steps,
message, rawOutput }`. `wrapHandler` (`src/tools/ev2-rollout.ts`) keeps
only `result.message` and discards the rest. `ToolError` (`src/errors.ts`)
carries `code`, `context`, `suggestion` — but `formatMcpError()` renders
those into a markdown blob *before* the router can preserve them.

Wrapping that in an envelope is decorative — the envelope's `result.data`
slot would be empty because the data already died at the wrapper boundary.

### F2. MCP 2025-11-25 already specifies most of what milestone 16 invents

The Exarchos epic proposes a JSON-in-text envelope shape, NDJSON streaming,
typed safety hints, and self-navigating responses. The current MCP spec
covers all four with stable primitives:

- `outputSchema` + `structuredContent` (server side, dual-channel
  rendering — spec says verbatim: *"For backwards compatibility, a tool
  that returns structured content **SHOULD** also return the serialized
  JSON in a TextContent block"*)
- Tool **annotations** (`destructiveHint`, `readOnlyHint`,
  `idempotentHint`, `openWorldHint`)
- **Tasks** (SEP-1686, Final) — request-augmenting two-phase pattern
  with create / poll / result / cancel semantics
- **Elicitation** for input requests (form mode + URL mode)
- **Roots** for project-boundary discovery
- **Resources** and **Prompts** as separate primitives

Both the TypeScript SDK (`@modelcontextprotocol/sdk@^1.12.0`, already in
our `node_modules/`) and the C# SDK (`ModelContextProtocol@v1.2.0`) ship
all of these as **stable** except Tasks, which both mark **experimental**.

### F3. Tasks maps onto `rollout monitor` exactly

| Today                                                                | With Tasks                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| `ev2_rollout({action:"monitor"})` shells out to `ev2.exe rollout get`, parses one snapshot, returns. Agent re-calls to track progress. | `tools/call` with `task: {ttl}` returns `CreateTaskResult` immediately. Background loop polls `ev2.exe`. Agent calls `tasks/get` per `pollInterval`; `tasks/result` when ready. |
| No protocol cancel — agent has to stop calling                       | `tasks/cancel` first-class                                 |
| No way to model human approval gates                                 | `input_required` status is the legitimate primitive       |
| Custom NDJSON envelope we'd have to design and document              | Capability-negotiated, spec-defined protocol              |

SEP-1686's customer use case #4 (test execution platforms wrapping
CI/CD pipelines) reads almost word-for-word as `ev2_rollout.monitor`
wrapping Ev2's rollout API.

### F4. Several existing ev2-mcp pain points have spec-native fixes

- `service-group.ts:resolveServiceGroupRoot()` walks `process.cwd()`
  upward — Roots is the spec equivalent and works correctly when the
  MCP server's cwd doesn't match the user's.
- `ActionRouter.dispatch()` returns `INVALID_INPUT` for missing
  parameters — Elicitation form mode lets us *ask* for the value
  instead.
- `ToolError.fromProcessError()` returns `AUTH_FAILED` with a prose
  suggestion to "run `az login`" — Elicitation URL mode could
  drive the device-code flow directly.
- `ActionMetadata.ev2Docs` strings link to MS Learn pages —
  Resources promote them to first-class browsable URIs.

### F5. CLI/MCP surface parity is currently broken

`src/mcp-server.ts` registers `createEv2GenevaTool`. `src/cli.ts`
`createDefaultRouters()` only includes `artifact / rollout / config /
setup`. The `geneva` tool is unreachable from the CLI surface today.
This is a cheap correctness fix that should ship before any envelope
work claims "identical on both surfaces."

### F6. Cross-OS coverage is missing

ev2-mcp is Windows-first and shells out to `ev2.exe`, but its TypeScript
path handling (`resolveServiceGroupRoot`), CRLF parsing in
`parseRolloutMonitorOutput()`, and regex-based stdout scraping are
exactly where Windows-only failures hide. Pipeline runs Linux-only
today. Adding `windows-latest` to the matrix is high signal at low cost
(live `ev2.exe` calls are mocked, so the matrix stays cheap).

## 2. Recommendations

### R1. Foundation: structured `ActionResult` (prerequisite for R2–R10)

Redesign `ActionResult` to preserve handler structure end-to-end:

```ts
type ActionResult =
  | { ok: true; message: string; data?: unknown; meta?: ActionMeta }
  | {
      ok: false;
      message: string;
      error: { code: ToolErrorCode; message: string; context?: Record<string, unknown> };
      fix?: string;          // == ToolError.suggestion
      meta?: ActionMeta;
    };

type ActionMeta = {
  operationId: string;       // uuid per dispatch
  ev2Command?: string[];     // e.g. ["rollout", "get", "..."]
  exitCode?: number;
  elapsedMs: number;
  guards?: GuardOutcomeMeta[];
  contractVersion: "ev2-mcp.v1";
};
```

**Where it lands:** `src/types.ts`, `src/action-router.ts`,
`src/wrappers.ts`, `src/tool-helpers.ts`. Per-tool handlers stop
pre-formatting and return structured results; renderers do the
formatting late.

**Constraint:** keep raw stderr/stdout out of `meta.guards` — redact or
omit. These responses cross MCP boundaries.

### R2. `outputSchema` + `structuredContent` on every tool

Register a Zod `outputSchema` per tool matching the R1 `ActionResult`
shape. `callHandler()` returns both `content` (text rendered from
`message`) and `structuredContent` (object validated against the
schema). The dual-channel pattern is the official 2025-11-25 spec
guidance — no envelope-in-text needed.

**Where it lands:** every `createEv2*Tool()` registration in
`src/tools/ev2-*.ts` gains an `outputSchema` parameter.

### R3. Tool annotations + custom safety field (combined)

Compute spec annotations and a custom `safety` field from one source
of truth per tool action:

| Action                                                                    | `safety`           | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ------------------------------------------------------------------------- | ------------------ | -------------- | ----------------- | ---------------- |
| `*.describe`, `*.status`, `*.monitor`, `*.validate`, `*.lint`, `*.version_read`, `config.{get,list,diff}` | read-only          | true           | false             | true             |
| `artifact.scaffold`, `artifact.bicep_build`, `artifact.version_bump`, `geneva.scaffold` | local-mutation     | false          | false             | depends          |
| `rollout.{register,new,pause,resume,cancel}`, `setup.*`, `config.set`     | remote-mutation    | false          | usually true      | depends          |

**Why both:** spec annotations are explicitly **untrusted**
(spec §Tools / Annotations: *"clients **MUST** consider tool annotations
to be untrusted unless they come from trusted servers"*). They're
client-UI hints. The custom `safety` field in `ActionMeta` is
server-trusted gating metadata that our own `next_actions` and guards
consume.

### R4. Per-call `_meta.guards` + `_meta.operationId` observability

Each wrapper (`withStateGuard`, `withIdempotencyCheck`, `withPreflight`,
etc.) records its outcome into a per-request collector. The collector
attaches to `ActionMeta.guards` before the response leaves the router.
Format:

```ts
guards: [
  { name: "versionExistsGuard", kind: "allow", policy: "fail_closed", elapsedMs: 12 },
  { name: "registrationProbe", kind: "diverged", policy: "fail_open", elapsedMs: 842 },
]
```

`operationId` is a new UUID per dispatch. Combined with `ev2Command`,
`exitCode`, and `elapsedMs`, this is the ev2-mcp-shaped equivalent
of an event store: per-call observability without persistent
infrastructure.

### R5. Roots-based `serviceGroupRoot` autodetection

Replace the cwd walk in `service-group.ts:resolveServiceGroupRoot()`
with the protocol-native flow:

1. If `serviceGroupRoot` is omitted **and** the client declares the
   `roots` capability, call `roots/list`.
2. Walk each returned root for a recognizable SGR shape
   (ServiceModel.json + Parameters/ + Bicep/).
3. If exactly one root matches, use it. If zero, fall back to the
   existing cwd walk. If multiple, return an `INVALID_INPUT` error
   (or use Elicitation per R9 to ask the user).

**Backward compat:** CLI surface unchanged (no client to ask). Existing
explicit-path callers see no change.

### R6. Tasks (SEP-1686) for `rollout monitor`

Adopt with explicit experimental-API risk acceptance, bounded to one
tool initially.

```ts
server.experimental.tasks.registerToolTask("ev2_rollout", {
  inputSchema: ev2RolloutSchema.shape,
  outputSchema: rolloutMonitorOutputSchema.shape,
  execution: { taskSupport: "optional" },
}, {
  createTask: async (args, extra) => {
    const task = await extra.taskStore.createTask({ ttl: 3_600_000 }); // 1h
    startBackgroundMonitor(task.taskId, args, extra.taskStore);
    return { task };
  },
  getTask: (_args, extra) => extra.taskStore.getTask(extra.taskId),
  getTaskResult: (_args, extra) => extra.taskStore.getTaskResult(extra.taskId),
});
```

**Why `taskSupport: "optional"`:** clients that don't understand Tasks
get the existing one-shot behavior; clients that do can opt into
polling. No breaking change.

**Why in-memory TaskStore is acceptable:** Ev2 owns the durable rollout
state. Our task is a polling cache for an external system. If the MCP
server restarts mid-monitor, the agent re-creates the task and we
resume polling Ev2 from scratch.

**Risk mitigation:**
- Confine to one tool (`ev2_rollout.monitor`) so a breaking SDK change
  has bounded blast radius.
- Pin `@modelcontextprotocol/sdk` to a fixed minor version, not a
  caret range.
- Treat the API as adoption-zone-only until the spec text drops the
  "experimental" marker (SEP-1686 is already Final on the SEP track).

### R7. Typed `next_actions` from errors and guards (not prose)

Generate `next_actions` from high-confidence sources:

- `ToolError` → corrective action (e.g. `versionExistsGuard` block →
  `ev2_artifact.version_bump`)
- Guard outcomes (block → corrective; unknown → diagnostic)
- Known sequencing (after `register` → `rollout new`; after
  `rollout new` non-terminal → `rollout monitor` with `delaySeconds`)

Typed shape (lives in `outputSchema`):

```ts
type NextAction = {
  id: string;                    // "register-before-rollout"
  tool: string;                  // "ev2_rollout"
  action: string;                // "register"
  reason: string;                // "Artifacts are not registered for this rolloutInfra."
  params?: Record<string, { value?: unknown; default?: unknown; enum?: unknown[]; description?: string }>;
  safety: "read-only" | "local-mutation" | "remote-mutation";
  source: "error" | "guard" | "convergence-probe" | "metadata";
  confidence: "high" | "medium" | "low";
};
```

**Do not** auto-derive from `ActionMetadata.relatedActions` — those
are documentation prose, not executable templates.

### R8. MCP Resources for Ev2 docs (and SGR file tree as follow-up)

First ship: docs only. Promote `ActionMetadata.ev2Docs` strings to
MCP Resources so agents can fetch / subscribe to canonical Ev2
documentation pages without leaving the MCP boundary.

Follow-up (separate work item): expose the resolved SGR file tree
(ServiceModel.json, RolloutSpec.jsonc, Configurations/, Bicep/) as
`file://` resources so agents can introspect the deployment shape
without going through the host filesystem.

### R9. Elicitation for `INVALID_INPUT` and `AUTH_FAILED`

Two specific flows where elicitation strictly improves on today's
behavior:

1. **Form mode for missing required parameters.** When
   `ActionRouter.dispatch` finds a missing required param **and** the
   client declares `elicitation`, send `elicitation/create` with a
   schema for the missing field instead of returning `INVALID_INPUT`.
2. **URL mode for `AUTH_FAILED`.** When `ToolError.fromProcessError`
   detects `AADSTS|Unauthorized`, drive the user through the device-code
   sign-in via URL-mode elicitation. No credentials pass through the
   MCP client (spec forbids form mode for credentials).

Existing error paths remain as fallback for clients without elicitation
support.

### R10. Output-size truncation with rerunnable pointer

For `validate` / `lint` / `monitor` outputs that can produce
screenfuls:

- summarize: counts by severity, first N findings inline
- support `maxFindings` and `includeRawOutput` parameters
- include the rerunnable command for full output (e.g.
  `isce-ev2 artifact validate --rolloutInfra Test --maxFindings 0`)

Because ev2-mcp is stateless, the "pointer" is a rerunnable command —
not an event-store ID.

### R11. Cross-OS CI matrix

Extend `.pipelines/OneBranch.PullRequest.Build.yml` (or per-tool CI) to
run `npm run test` on both `windows-latest` and `ubuntu-latest`. Live
`ev2.exe` calls are mocked, so the matrix stays cheap. Catches
Windows-specific path/CRLF/regex bugs at PR time.

### R12. `ev2_geneva` CLI router parity

Add `createEv2GenevaRouter()` and wire it into `cli.ts`
`createDefaultRouters()`. Gate before any envelope work claims "MCP/CLI
parity."

## 3. Recommended sequencing

```
                     ┌─────────────────────────────────────┐
                     │  R11 Windows CI    R12 geneva CLI   │  ← parallel, no foundation
                     └─────────────────────────────────────┘
                                          ┃
                                          ▼
                     ┌─────────────────────────────────────┐
                     │  R1 structured ActionResult         │  ← prerequisite
                     └─────────────────────────────────────┘
                                          ┃
                  ┌───────────────────────┼───────────────────────┐
                  ▼                       ▼                       ▼
       ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
       │  R2 outputSchema  │  │  R4 _meta.guards  │  │  R5 Roots         │
       │  R3 annotations   │  │     operationId   │  │                   │
       └───────────────────┘  └───────────────────┘  └───────────────────┘
                                          ┃
                  ┌───────────────────────┼───────────────────────┐
                  ▼                       ▼                       ▼
       ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
       │  R6 Tasks         │  │  R7 next_actions  │  │  R8 Resources     │
       │  (rollout monitor)│  │     R9 Elicitation│  │     (docs first)  │
       └───────────────────┘  └───────────────────┘  └───────────────────┘
                                                                 ┃
                                                                 ▼
                                                      ┌───────────────────┐
                                                      │  R10 truncation   │
                                                      │  (when needed)    │
                                                      └───────────────────┘
```

**Don't start R2–R10 before R1 lands** — they all consume the
structured `ActionResult` shape.

**R6 (Tasks) is independent of R7/R8/R9** — could ship in parallel once
R1+R2 are in.

**R10 (truncation) is opportunistic** — ship when a `validate`/`lint`
output bites someone, not on speculation.

## 4. Patterns explicitly dropped during synthesis

Each of these was in one of the source spikes; the synthesis dropped
them. Documented here so future readers don't re-litigate.

| Pattern                                          | Why dropped                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| HATEOAS envelope as JSON-in-text wrapper         | Superseded by R2 (`structuredContent`). MCP carries the envelope natively. |
| NDJSON streaming for `--follow`                  | Superseded by R6 (Tasks). NDJSON would be dressed-up polling without the spec's capability negotiation. |
| Pre-Tasks Progress notifications                 | Superseded by R6 (Tasks) for the only ev2-mcp use case.                  |
| MCP Sampling                                     | NA — would invert the agent loop (the model is *outside* the tool).      |
| MCP Prompts                                      | Defer — scaffold templates fit the existing `artifact.scaffold` action better than the user-selectable Prompt model. |
| Machine-readable invariant catalog (`#1260`)     | Defer — adopt only if a consumer (lint rule, generated skill prompt) is queued. Otherwise becomes another prose doc to keep in sync. |
| SQLite event store, HSM phase API, capability resolution (`#1259`) | NA — ev2-mcp is stateless; Ev2 owns the durable state.   |
| Token-budget quality hint (`#1262` literal)      | NA — we don't measure tokens. Use R10 (size-based) instead.              |

## 5. Patterns NOT applicable to ev2-mcp at all

These came from the broader Exarchos research surface and are
documented here only to close the loop:

- Dispatch-guard observability events (`#1261`) — adopted as a *pattern*
  in R4, but without an event store the literal events don't apply.
- Cross-cutting invariants file for `/ideate` (`#1260`) — no `/ideate`
  skill in ev2-mcp.
- Subagent capability resolution (`#1259` Q5) — no agent capability
  declarations in ev2-mcp.

## 6. Decision points (team review required before any work begins)

Each of these affects the shape of the recommendations above. The team
should explicitly answer them before any implementation work starts.

1. **Accept the experimental-Tasks API stability risk?** Both SDKs
   may break the surface in their next major. Recommendation: yes,
   bounded to R6 only (`ev2_rollout.monitor`), with pinned SDK
   minor version.
2. **TaskStore persistence?** TS SDK ships in-memory only.
   Recommendation: in-memory acceptable — Ev2 owns the durable state.
   Document the restart-during-monitor behavior.
3. **Roots adoption — breaking change to `serviceGroupRoot` parameter?**
   Recommendation: no breaking change. Roots used only when
   `serviceGroupRoot` is omitted and the client declares `roots`.
4. **Resources scope on first ship — docs only, or +SGR file tree?**
   Recommendation: docs only first.
5. **Elicitation scope — form mode only, or +URL mode for auth?**
   Recommendation: form mode for `INVALID_INPUT` first; URL mode for
   `AUTH_FAILED` requires more thought about device-code vs
   interactive-browser choice.
6. **Bundled-skills coordination.** ev2-mcp ships skills
   (`ev2-deploy`, `ev2-troubleshoot`, etc.) that reference the current
   tool surface. Do skill prompts get refreshed in the same release as
   R2/R3 (which change response shapes), or one release behind?
   Recommendation: same release — skills should reference the
   structured `data.next_actions` once available, otherwise we ship
   silent regressions.

## 7. Open risks

- **Tasks experimental status drift.** SEP is Final, spec text marks
  "experimental," both SDKs mark experimental. Any of these may move
  out of sync. Mitigation: R6 risk-acceptance plus pinned SDK version.
- **Client compatibility unverified.** This synthesis explicitly
  scoped out a client compatibility matrix (per the conformance spike's
  scope refinement). Before R6 ships, verify that at least the primary
  ev2-mcp consumer clients (Copilot CLI, VS Code MCP) handle
  `taskSupport: "optional"` correctly — i.e. fall back to one-shot
  rather than erroring.
- **Backward compatibility for plain-text consumers.** Existing CLI
  output stays text by default (R1 renders to text in the renderer
  layer). PowerShell scripts grep'ing stdout see no change. Verify
  with a sample script before R1 ships.
- **Skill drift.** R7 changes how agents discover next steps. Bundled
  skills currently embed action sequencing in prose. Without a
  coordinated skill update (decision point 6), agents may double-suggest
  (skill prose says one thing, `next_actions` says another).

## 8. Sources

### Supporting research (preserved)

- `docs/research/2026-05-07-exarchos-m16-patterns-spike.md` — original
  applicability analysis for milestone-16 patterns
- `docs/research/2026-05-07-mcp-protocol-conformance.md` — MCP SDK /
  protocol conformance audit; resolved several recommendations from
  the first spike

### External references

- [Exarchos milestone 16](https://github.com/lvlup-sw/exarchos/milestone/16)
  (epic `#1088`, sub-issues `#1098`, `#1099`, `#1100`, plus adjacent
  `#1170`, `#1259`, `#1260`, `#1261`, `#1262`)
- [MCP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [SEP-1686: Tasks](https://modelcontextprotocol.io/seps/1686-tasks.md)
- [TypeScript SDK `@modelcontextprotocol/sdk@^1.12.0`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [C# SDK `ModelContextProtocol@v1.2.0`](https://www.nuget.org/packages/ModelContextProtocol)

### Local prior art

- `docs/designs/2026-04-27-composable-handler-wrappers.md` — the
  wrapper composition pattern this synthesis builds on
- `src/tools/ev2-mcp/` — current implementation (see individual
  `Sources` sections in the supporting research docs for file-level
  references)
