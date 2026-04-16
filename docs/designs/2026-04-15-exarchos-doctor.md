# exarchos doctor — preflight diagnostics with shared runtime detector

**Issue:** [#1089](https://github.com/lvlup-sw/exarchos/issues/1089) (v2.8.0 P3)
**Target version:** v2.8.0
**Cross-cutting reference:** [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) (event-sourcing integrity + MCP parity)
**Related:** [#1091](https://github.com/lvlup-sw/exarchos/issues/1091) (enhanced init — consumes the shared detector introduced here)

## Overview

Add `exarchos doctor` — a diagnostic command that runs a fixed list of health checks and returns a machine-readable report. Surfaced on CLI as a top-level command and on MCP as `exarchos_orchestrate({action: "doctor"})`, both projecting through the same handler in the dispatch core.

The PR also lands the `AgentEnvironmentDetector` primitive that #1091 will consume, so both doctor and init share a single source of truth for "which agent runtime configs exist in this project." This is the sequencing decision made during ideate (option c): pull the detector forward rather than duplicate it or defer doctor's agent-aware checks.

## Quality dimensions applied

Design scored against axiom backend-quality dimensions (DIM-1 through DIM-8). Dimension IDs cited inline at each load-bearing decision.

| Framework | Dimension | Principle applied |
|-----------|-----------|-------------------|
| Axiom | DIM-1 Topology | Detector injected through `DispatchContext`; no module-globals; absence is a startup error, not silent fallback |
| Axiom | DIM-2 Observability | Each check surfaces observed state + actionable fix; no silent passes; skip reason always recorded |
| Axiom | DIM-3 Contracts | Single Zod schema for `DoctorOutput`; TS types derived from it; both adapters project through the same shape |
| Axiom | DIM-4 Test Fidelity | Parity test invokes doctor through real CLI and MCP adapters; per-check tests inject probes, not module-level mocks |
| Axiom | DIM-5 Hygiene | Call-out of existing `src/runtimes/detect.ts` vs new `AgentEnvironmentDetector` to prevent future duplication |
| Axiom | DIM-6 Architecture | Inward dependencies: `runtime/` ← `orchestrate/doctor/` ← `adapters/*`; per-check files bounded under 50 lines |
| Axiom | DIM-7 Resilience | Per-check `AbortSignal` + timeout; sqlite `integrity_check` bounded; remote-MCP stub defaults to skipped |
| Axiom | DIM-8 Prose Quality | Check messages and fix strings follow `<observed state>. <imperative fix>` pattern; no filler |
| Impeccable | UX Writing | Each check's `fix` is a runnable command where possible (`exarchos init`, `npm install`, etc.) |

## Architecture

### Module layout

```
servers/exarchos-mcp/src/
├── runtime/
│   ├── agent-environment-detector.ts        # NEW — the shared primitive
│   └── agent-environment-detector.test.ts
├── orchestrate/
│   ├── doctor/
│   │   ├── index.ts                         # Composer: probes → parallel run → summary → event
│   │   ├── schema.ts                        # Zod schema + derived TS types
│   │   ├── probes.ts                        # Injectable probe bundle (fs, env, git, sqlite, detector)
│   │   ├── checks/
│   │   │   ├── runtime-node-version.ts
│   │   │   ├── storage-sqlite-health.ts
│   │   │   ├── storage-state-dir.ts
│   │   │   ├── vcs-git-available.ts
│   │   │   ├── agent-config-valid.ts        # Consumes AgentEnvironmentDetector
│   │   │   ├── agent-mcp-registered.ts      # Consumes AgentEnvironmentDetector
│   │   │   ├── plugin-skill-hash-sync.ts
│   │   │   ├── plugin-version-match.ts
│   │   │   ├── env-variables.ts
│   │   │   └── remote-mcp-stub.ts           # Skipped by default until basileus
│   │   └── index.test.ts                    # Composer tests (timeout, abort, summary math)
│   └── doctor.parity.test.ts                # CLI↔MCP parity (mirrors review-verdict.parity.test.ts)
```

Each check file is ≤50 lines (DIM-6/T-6.1b). Per-check tests are co-located following the project convention and inject probes directly rather than module-level mocks, which keeps each test under the DIM-4/T-4.2 three-mock threshold.

### Handler contract

```ts
// schema.ts — single source of truth (DIM-3)
export const CheckStatusSchema = z.enum(['Pass', 'Warning', 'Fail', 'Skipped']);

export const CheckResultSchema = z.object({
  category: z.enum(['runtime', 'storage', 'vcs', 'agent', 'plugin', 'env', 'remote']),
  name: z.string().min(1),
  status: CheckStatusSchema,
  message: z.string().min(1),
  fix: z.string().optional(),        // actionable command or guidance
  reason: z.string().optional(),     // required when status === 'Skipped'
  durationMs: z.number().int().nonnegative(),
});

export const DoctorOutputSchema = z.object({
  checks: z.array(CheckResultSchema),
  summary: z.object({
    passed: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
});

export type CheckResult = z.infer<typeof CheckResultSchema>;
export type DoctorOutput = z.infer<typeof DoctorOutputSchema>;
```

TypeScript types are derived from Zod (`z.infer`), eliminating DIM-3/T-3.3 schema-type divergence by construction.

### AgentEnvironmentDetector contract

The new detector answers "which runtime configs exist in this project" — a different question from `src/runtimes/detect.ts`, which answers "which runtime binary is installed on PATH" for install-skills targeting. The two compose but do not duplicate; this separation is enforced by keeping them in different packages.

```ts
export interface AgentEnvironment {
  name: 'claude-code' | 'codex' | 'cursor' | 'copilot' | 'opencode';
  configPath: string;                    // e.g., ~/.claude.json
  configPresent: boolean;
  configValid: boolean;                  // JSON parses, required keys present
  mcpRegistered: boolean;                // exarchos entry in MCP server list
  skillsDir?: string;                    // e.g., ~/.claude/skills
}

export interface DetectorDeps {
  fs?: { readFile(p: string): Promise<string>; stat(p: string): Promise<{ isDirectory(): boolean }> };
  home?: () => string;
  cwd?: () => string;
}

export async function detectAgentEnvironments(
  deps?: DetectorDeps,
  signal?: AbortSignal,
): Promise<AgentEnvironment[]>;
```

Pure function, no module-globals (DIM-1/T-1.1 avoided). All side effects injected through `deps` with `process.*` defaults; tests override both (DIM-4/T-4.3). Missing deps are a type error, not a runtime silent-fallback (DIM-1/T-1.2).

**DIM-5 call-out:** `src/runtimes/detect.ts` stays as-is. It remains the "install-skills runtime targeting" primitive. The new detector's JSDoc links to it explicitly so future contributors see the distinction. If the two ever converge on a shared signal, the consolidation belongs to a hygiene pass, not this PR.

### Composer flow

```
exarchos doctor (CLI)                  exarchos_orchestrate({action:"doctor"}) (MCP)
         │                                              │
         └──────────────┬───────────────────────────────┘
                        ▼
            dispatch('exarchos_orchestrate', {action:'doctor'}, ctx)
                        ▼
               handleDoctor(args, ctx)                 ← orchestrate/doctor/index.ts
                        ▼
  probes = buildProbes(ctx)                            ← orchestrate/doctor/probes.ts
                        ▼
  Promise.all(checks.map(c => runWithTimeout(c, probes, signal, 2000)))
                        ▼
  summary = tally(results)
                        ▼
  ctx.eventStore.append({ type: 'diagnostic.executed', data: { summary, checkNames } })
                        ▼
  return { success: true, data: DoctorOutputSchema.parse({ checks, summary }) }
```

Checks run in parallel under a shared `AbortController` with 2000ms default per-check timeout (DIM-7/T-7.2). Timeouts surface as `Warning` with a `fix` field suggesting investigation, not as silent hangs. The composer validates the output through `DoctorOutputSchema.parse` before returning, failing loudly if a check violates the contract (DIM-3).

### Event emission

A new event type `diagnostic.executed` is added to `event-store/schemas.ts`:

```ts
// event-store/schemas.ts
'diagnostic.executed',
// ...
DiagnosticExecutedDataSchema = z.object({
  summary: DoctorOutputSchema.shape.summary,
  checkCount: z.number().int().nonnegative(),
  failedCheckNames: z.array(z.string()),   // names only, not full payloads
  durationMs: z.number().int().nonnegative(),
});
```

The event carries a summary projection, not the full checks array — full check payloads would bloat the event store without adding audit value. Failed check names are included so operators can track recurring failures over time without re-running doctor.

### CLI surface

Top-level command `exarchos doctor` lands in `adapters/cli.ts` as a new sub-command. It accepts `--format <table|json>` (default table), `--timeout <ms>` (per-check override), and returns:

- Exit code 0 when all checks pass or are warnings/skipped
- Exit code 2 (`HANDLER_ERROR`) when any check fails
- Exit code 1 (`INVALID_INPUT`) on flag validation error
- Exit code 3 (`UNCAUGHT_EXCEPTION`) on unexpected throw

This matches the existing `CLI_EXIT_CODES` contract in `adapters/cli.ts`. Warnings do not fail the exit code — that's intentional per the issue's acceptance criteria; operators running doctor in CI want to surface issues without blocking pipelines.

### MCP surface

`exarchos_orchestrate({action: "doctor"})` routes through `orchestrate/composite.ts` into `handleDoctor`. The action is added to the orchestrate registry's action schema in `registry.ts` with the same Zod schema as the CLI flags, so parity is enforced at the type level.

## Cross-cutting constraints (baked in from ideate)

### 1. Pre-audit for duplication (DIM-5)

Pre-audit complete: existing `src/runtimes/detect.ts` handles binary presence detection and is NOT a duplicate of this design's `AgentEnvironmentDetector`. The difference is documented inline in both files' JSDoc. Any future contributor proposing a third detector must justify why the two existing primitives can't compose.

### 2. Prose discipline (DIM-8)

Every `CheckResult.message` and `CheckResult.fix` follows `<observed state>. <imperative fix>`. Examples:

- Pass: `"SQLite backend healthy (exarchos.db, 2.4 MB)"`
- Warning: `"MCP server not found in .claude.json."` + `fix: "exarchos init"`
- Fail: `"Node.js 18.17.0 detected. Exarchos requires Node.js >= 20."` + `fix: "Upgrade Node via nvm install 20 or your package manager"`

No filler (`"serves as a testament to..."`, `"in order to..."`). No superficial -ing analyses (`"ensuring robust diagnostics"`). Strings are reviewed against axiom:humanize before merge.

### 3. Observable fallback (DIM-2)

When a check cannot run (missing dep, unsupported platform, feature not configured), the result is `Skipped` with a required `reason` field — never a silent `Pass`. The remote-MCP stub check is the canonical example: until basileus ships, it returns `{ status: 'Skipped', reason: 'Remote MCP not configured; basileus integration pending (#1081)' }`.

## Testing strategy

Three layers, mirroring the existing parity-test convention in `orchestrate/`:

**Unit tests (per-check):** Each `checks/<name>.ts` has a co-located `<name>.test.ts` that injects probes and asserts on the returned `CheckResult`. No module-level `vi.mock` — probes are plain object arguments. This keeps every test under DIM-4/T-4.2's three-mock flag.

**Composer tests (`orchestrate/doctor/index.test.ts`):** Verify parallel execution, timeout enforcement, abort propagation, summary tally, and event emission via an in-memory `EventStore` test double.

**Parity tests (`orchestrate/doctor.parity.test.ts`):** Invoke doctor through the real CLI adapter (spawn or direct function call) and through the real MCP adapter. Assert both return byte-identical `DoctorOutput` JSON given the same probes. This catches any CLI/MCP projection divergence — the single most common failure mode for shared-handler features, per the existing `parity-harness.ts`.

## Acceptance criteria traceability

Mapped 1:1 from [#1089](https://github.com/lvlup-sw/exarchos/issues/1089):

| Issue AC | Design coverage |
|----------|----------------|
| `exarchos doctor` in dispatch core (shared CLI+MCP) | `orchestrate/doctor/index.ts` wired through `COMPOSITE_HANDLER_LOADERS` |
| MCP tool `exarchos_orchestrate({action: "doctor"})` | Action added to orchestrate registry |
| ≥8 diagnostic checks across categories | 10 checks listed in layout |
| Each check has category/name/message/status | Enforced by `CheckResultSchema` |
| Failed/warning checks include `fix` field | Schema allows; convention enforces for non-Pass |
| `diagnostic.executed` event emitted | New event type in `event-store/schemas.ts` |
| `--format json` machine-readable; default table | `adapters/cli-format.ts` already supports both |
| Exit 0 all pass / exit 1 any fail / warnings don't fail | Maps to `CLI_EXIT_CODES.HANDLER_ERROR` from ToolResult.success |
| Co-located tests per check | `checks/<name>.test.ts` pattern |

## Out of scope

- **#1091's full `init` rewrite.** Only the detector primitive lands here; init refactor is its own issue.
- **#1081 remote MCP connectivity.** Stub check ships skipped; real implementation is a follow-up.
- **Plugin-registered custom checks.** Rejected in ideate as premature (would introduce module-global registry state — DIM-1/T-1.1). If basileus ever needs this, it belongs in #1109.
- **Doctor auto-fix.** Doctor reports; it does not mutate state. A separate `exarchos fix` verb would be a future addition if operator demand materializes.

## Risks and mitigations

- **Risk:** sqlite `integrity_check` can block on corrupt DBs. **Mitigation:** run inside the composer's 2000ms timeout; on timeout, emit `Warning` with fix `"Run exarchos export to bundle events, then investigate .exarchos/events.db"`.
- **Risk:** Detector filesystem access on exotic paths (Windows junction points, WSL). **Mitigation:** all fs calls through injected `deps.fs`, deps default to `node:fs/promises`; Windows-specific path handling deferred until a Windows CI gap closes (known issue per project memory `project_windows_ci_gap.md`).
- **Risk:** Parity test drift — CLI and MCP outputs diverging silently. **Mitigation:** parity test asserts byte-equality of JSON, not just shape; any whitespace/ordering difference fails the test.

## Appendix: Aspire patterns referenced

- `DoctorTool.cs` in Aspire CLI 13.2 — same dispatch-core-shared-across-CLI-and-server pattern
- `IEnvironmentChecker` — per-check pure-function shape
- Machine-readable output with per-check `fix` fields — transferred verbatim
