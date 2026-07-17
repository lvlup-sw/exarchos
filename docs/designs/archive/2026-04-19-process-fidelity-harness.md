# Design: Process-Fidelity Test Harness

**Status:** Design (ideate phase). Implementation plan will follow.
**Workflow:** `process-fidelity-harness`
**Date:** 2026-04-19
**Source research:** `docs/research/2026-04-19-e2e-testing-strategy.md` (Tier 1)

## 1. Summary

Exarchos ships a CLI binary and an MCP server binary, but today's 420 tests drive only the in-process module graph. This design specifies the **shared fixture library** that makes process-fidelity tests feasible: a small set of procedural helpers for hermetic environment setup, MCP-server process spawning, CLI invocation, and response normalization.

This is the foundation for Tier 1 of the e2e testing strategy. It lands as one PR. Four follow-up PRs consume it: F2 MCP smoke tests, F2 CLI smoke tests, F3 `@modelcontextprotocol/conformance` integration, and a Windows CI matrix extension.

The design closes the axiom DIM-4 (Test Fidelity) gap at the process boundary: tests will spawn the real binaries, speak real JSON-RPC over real stdio, and assert on real responses, using wiring that mirrors production step-for-step.

## 2. Problem

Per the research doc, today's test suite covers approximately one tuple of the 54-cell (OS × harness × invocation-surface) ship surface. No test crosses the process boundary between Exarchos's shipped binary and its consumer. This means:

- A server that fails to start because of a missing runtime flag passes every in-process handler test.
- A regression in the `bin` wrapper passes every CLI function test.
- A Zod-schema change that breaks JSON-RPC tool-call parsing passes every unit test.
- A Windows-specific `path.resolve` bug ships undetected, because CI is Linux-only.
- The "MCP parity" contract in [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) has no operational definition, because no test compares CLI output to MCP output.

The shared fixture library is the prerequisite for fixing all of the above. It is not itself a test suite; it is the foundation that makes the follow-up test suites cheap to write.

## 3. Scope

### 3.1 In scope for this design (PR 1)

- `withHermeticEnv(callback)` — single-mode hermetic environment wrapper.
- `spawnMcpClient(opts)` — spawns the built MCP server binary and returns a connected `Client`.
- `runCli(opts)` — invokes a CLI binary in the hermetic env, returns `{ stdout, stderr, exitCode }`.
- `normalize(value)` — canonicalizes timestamps, event sequences, IDs, and paths for equivalence assertions.
- `expectNoLeakedProcesses()` — global `afterEach` hook asserting all spawned children have terminated.
- Vitest `projects` split defining `unit`, `integration`, and `process` projects.
- `test/fixtures/` directory layout.

### 3.2 In scope for follow-up PRs (not this design)

| PR | Owner issue | Scope |
|----|-------------|-------|
| PR 2 | `exarchos#<F2-mcp>` | First F2 MCP smoke test: `exarchos_workflow` init/get round-trip over stdio. |
| PR 3 | `exarchos#<F2-cli>` | First F2 CLI smoke test: `exarchos install` against tmp `$HOME`, assert filesystem result. |
| PR 4 | `exarchos#<F3-conformance>` | Integrate `@modelcontextprotocol/conformance` as a `conformance` vitest project. |
| PR 5 | `exarchos#<win-ci>` | Extend GitHub Actions matrix to include `windows-latest` for the `unit` project. |

Each follow-up PR gets its own ideate and design. This design only commits to: **the fixture library exposes the right primitives for PRs 2–5 to consume.**

### 3.3 Out of scope entirely

- Per-action parity contract schema (belongs in PR 4's design).
- macOS CI runner (Tier 2).
- F4 platform probes, F5 per-runtime install fixtures, F6 lifecycle tests (Tiers 2 and 3).
- Harness-internal behavior tests.
- LLM-driven conversation tests (`mcpjam` territory).

## 4. Architecture

### 4.1 Library shape: procedural functional

Four top-level exports, each a direct mirror of a production wiring step. No abstractions on top. No context objects, no vitest plugins, no custom matchers.

Rationale vs. alternatives (context-object pattern; vitest fixture injection) is documented in the ideate transcript. Axiom grounding:

- **DIM-4:** call sites mirror production wiring; tests read as small programs doing what the harness does.
- **DIM-6:** tight single-responsibility per function.
- **DIM-5:** minimal surface; no config paths; no optional facades.
- **DIM-1:** every resource's lifecycle is visible at the call site.

### 4.2 Binary invocation targets

**F2 MCP:** `(b)` `npm link`-resolved binary on `PATH`. `spawnMcpClient` resolves `exarchos-mcp` from `PATH` at call time. This exercises the `bin` entry in `package.json` and the shebang wrapper. Setup step in CI: `npm link` once before the `process` project runs.

**F2 CLI:** target-agnostic. `runCli(opts)` takes `{ command, args, env, cwd }` and runs it. For the initial PR 3, tests pass `command: 'exarchos-install'` (the `npm link`-resolved binary). When [#1115](https://github.com/lvlup-sw/exarchos/issues/1115)'s `get-exarchos.sh` bootstrap ships, a second test file wires `command` to the downloaded binary with zero harness changes. Target `(c)` (`create-exarchos`-scaffolded install) is **not supported** — `create-exarchos` is on the deprecation path per [#1043](https://github.com/lvlup-sw/exarchos/issues/1043), and investing fixtures in it is sunk cost.

A comment on [#1115](https://github.com/lvlup-sw/exarchos/issues/1115) ([comment-4277752096](https://github.com/lvlup-sw/exarchos/issues/1115#issuecomment-4277752096)) cross-links the F2 CLI requirements so the bootstrap-script work can wire in the second target without re-deriving the design.

### 4.3 Hermeticity model

Single-mode. `withHermeticEnv(callback)`:

1. Creates `tmp/<test-id>/{home,state,cwd,git}/`.
2. Sets `HOME`, `EXARCHOS_STATE_DIR`, `process.chdir(tmpCwd)`, and runs `git init` in `tmpGit` if needed.
3. Runs the callback.
4. Unconditionally cleans up in `finally`: restores env, restores CWD, removes tmp tree.

**No mode flag.** The axiom reasoning from the ideate stands: because F2 tests spawn the real binary as a fresh subprocess, the server's module graph is fully isolated by construction. The test driver is thin; env + CWD + FS reset is sufficient. A multi-mode helper would violate DIM-1 (conditional ambient state), DIM-5 (unused config paths), and DIM-6 (fuzzy responsibility).

### 4.4 Normalizer

`normalize(value: unknown): NormalizedShape` walks the input and canonicalizes non-deterministic fields.

**PR 1 minimum set:**

| Field pattern | Replacement |
|---------------|-------------|
| ISO-8601 timestamps | `<TIMESTAMP>` |
| `_eventSequence`, `sequence` | `<SEQ>` |
| Absolute paths under `tmp/` | `<WORKTREE>/<RELATIVE>` |
| UUIDs | `<UUID>` |
| MCP request IDs | `<REQ_ID>` |

**Function signature is fixed.** The per-action parity schema (what tolerance is applied to which fields for which action) lives in PR 4's design. PR 4 extends `normalize` as needed; PR 1 ships only these five rules.

### 4.5 Vitest project split

`vitest.config.ts` grows a `projects` array:

```typescript
projects: [
  { name: 'unit',        include: ['src/**/*.test.ts', 'servers/exarchos-mcp/src/**/*.test.ts'] },
  { name: 'integration', include: ['servers/exarchos-mcp/src/__tests__/**/*.test.ts'] },
  { name: 'process',     include: ['test/process/**/*.test.ts'],      testTimeout: 15000 },
]
```

Future projects (`conformance`, `e2e`) added by follow-up PRs.

`package.json` scripts:

```
test:unit         — vitest --project unit --project integration
test:process      — vitest --project process
test:all          — vitest (all projects)
```

The existing `test:run` is aliased to `test:unit` to preserve current CI behavior.

### 4.6 File layout

```
test/
├── fixtures/
│   ├── hermetic.ts              — withHermeticEnv
│   ├── mcp-client.ts            — spawnMcpClient
│   ├── cli-runner.ts            — runCli
│   ├── normalizers.ts           — normalize
│   ├── process-tracker.ts       — expectNoLeakedProcesses
│   └── index.ts                 — barrel export
├── process/
│   └── .gitkeep                 — PR 2 adds first test here
└── setup/
    └── global.ts                — afterEach(expectNoLeakedProcesses) hook
```

## 5. Public API

### 5.1 `withHermeticEnv`

```typescript
export async function withHermeticEnv<T>(
  callback: (env: HermeticEnv) => Promise<T>
): Promise<T>;

export interface HermeticEnv {
  homeDir: string;      // tmp/<id>/home
  stateDir: string;     // tmp/<id>/state
  cwdDir: string;       // tmp/<id>/cwd (process.cwd during callback)
  gitDir: string;       // tmp/<id>/git (git init'd)
  testId: string;       // stable ID for this invocation
}
```

**Guarantees:**
- `process.env.HOME`, `process.env.EXARCHOS_STATE_DIR`, and `process.cwd()` are set for the duration of the callback.
- Cleanup runs unconditionally, even if the callback throws.
- Concurrent callers get non-overlapping `tmp/<id>/` directories.

### 5.2 `spawnMcpClient`

```typescript
export async function spawnMcpClient(opts?: SpawnMcpClientOpts): Promise<SpawnedMcpClient>;

export interface SpawnMcpClientOpts {
  command?: string;              // default: 'exarchos-mcp' (npm-link resolved)
  args?: string[];
  env?: Record<string, string>;  // merged with current env
  stateDir?: string;             // sets EXARCHOS_STATE_DIR
  timeout?: number;              // default: 10000ms for initialize
}

export interface SpawnedMcpClient {
  client: Client;                // @modelcontextprotocol/sdk Client
  server: ChildProcess;          // handle to the spawned process
  terminate(): Promise<void>;    // closes client, waits for process exit
  stderr: string[];              // captured stderr lines
}
```

**Guarantees:**
- Returns only after `client.connect(transport)` completes.
- `terminate()` is idempotent.
- If the process exits before initialize completes, `spawnMcpClient` rejects with captured stderr.

### 5.3 `runCli`

```typescript
export async function runCli(opts: RunCliOpts): Promise<CliResult>;

export interface RunCliOpts {
  command: string;               // e.g. 'exarchos-install'
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;                  // default: process.cwd()
  stdin?: string;
  timeout?: number;              // default: 30000ms
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}
```

**Guarantees:**
- Rejects on timeout; always returns a structured result otherwise (including non-zero exit codes).
- Does not throw on non-zero exit; caller asserts on `exitCode`.

### 5.4 `normalize`

```typescript
export function normalize<T>(value: T): Normalized<T>;
```

Recursively walks the input, replacing matched fields with the canonical placeholders listed in §4.4. Deterministic, pure, no I/O. The `Normalized<T>` type is structurally identical to `T` with replaced fields as strings.

### 5.5 `expectNoLeakedProcesses`

```typescript
export function expectNoLeakedProcesses(): void;
```

Inspects the process tracker (populated by `spawnMcpClient` and `runCli`). If any spawned child is still alive, fails the test and force-kills the leaked children. Wired globally via `test/setup/global.ts` registered in the `process` project's `setupFiles`.

## 6. PR sequencing

Per Option B from the ideate: shared fixtures land first, then independent follow-ups.

```
PR 1 (this design)           PR 2: F2 MCP smoke
┌──────────────────────┐     ┌──────────────────────┐
│ Shared fixtures      │────▶│ spawnMcpClient +     │
│ + vitest projects    │     │ exarchos_workflow    │
│ + CI wiring          │     │ round-trip test      │
└──────────────────────┘     └──────────────────────┘
         │
         ├───────────────────▶ PR 3: F2 CLI smoke
         │                    ┌──────────────────────┐
         │                    │ runCli + exarchos-   │
         │                    │ install filesystem   │
         │                    │ assertions           │
         │                    └──────────────────────┘
         │
         ├───────────────────▶ PR 4: F3 conformance
         │                    ┌──────────────────────┐
         │                    │ @modelcontextprotocol│
         │                    │ /conformance wrapped │
         │                    │ as vitest project    │
         │                    └──────────────────────┘
         │
         └───────────────────▶ PR 5: Windows CI
                              ┌──────────────────────┐
                              │ matrix: windows-     │
                              │ latest on unit       │
                              │ project only         │
                              └──────────────────────┘
```

PRs 2–5 are all independent of each other after PR 1 merges. They can land in any order.

## 7. Follow-up issues

One issue per follow-up PR, each referencing this design and folded into the appropriate v3.0 milestone:

| Issue title | Epic / milestone fold-in |
|-------------|--------------------------|
| `test(e2e): F2 MCP process-fidelity smoke — exarchos_workflow round-trip` | [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) (MCP parity cross-cutting) |
| `test(e2e): F2 CLI process-fidelity smoke — exarchos install against tmp $HOME` | [#1087](https://github.com/lvlup-sw/exarchos/issues/1087) (v3.0 P1: CLI ergonomic) |
| `test(e2e): integrate @modelcontextprotocol/conformance as vitest project` | [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) |
| `ci: add windows-latest to unit project matrix` | [#1118](https://github.com/lvlup-sw/exarchos/issues/1118) (platform-agnosticity) |

Issue bodies template: summary, fixture consumption list, acceptance criteria, axiom dimensions closed, blocking/blocked-by references.

## 8. Testing strategy

The fixture library itself needs tests. These live in `test/fixtures/*.test.ts` and run in the `unit` project (they don't need process fidelity; they *are* the process-fidelity infrastructure).

**Required coverage:**

- `withHermeticEnv`: env/CWD restored on throw; concurrent callers get non-overlapping tmp dirs; cleanup runs when callback succeeds and when it throws.
- `spawnMcpClient`: process-exit-before-initialize rejects with stderr; `terminate()` is idempotent; timeout path rejects cleanly.
- `runCli`: non-zero exit returned as structured result; timeout rejection; stdin piping.
- `normalize`: each canonical-field rule in isolation; idempotence (normalizing twice is a no-op); deep nested structures.
- `expectNoLeakedProcesses`: fails test when a live child remains; force-kills leaked children.

**Not tested here:** the actual contract of the MCP server or CLI. Those are PR 2's and PR 3's responsibility.

## 9. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `npm link` is non-deterministic across OSes | Document the link step in CI config; fail fast if `exarchos-mcp` not on `PATH` when `process` project runs. |
| Process spawn latency (~300ms per test) balloons CI time | Keep the `process` project to ≤20 tests through Tier 1; run it on Linux PR-gate only; defer matrix expansion to Tier 2. |
| Tmp-dir cleanup races on Windows under file locks | Use `fs.rm({ force: true, retryable: true })`; tolerate cleanup failure in `finally` with a logged warning, not a test failure. |
| Flaky process termination detection on slow CI runners | `terminate()` uses SIGTERM then SIGKILL after 3s; `expectNoLeakedProcesses` uses the same timeout. |
| Fixture library grows beyond its charter | Rule: if a helper is consumed by only one test file, it lives in that test file, not in `test/fixtures/`. |

## 10. Open questions (deferred to follow-up ideates)

These are flagged here so follow-up PRs can pick them up with context:

- **PR 2:** which Zod input schema validation errors should the smoke test cover, if any?
- **PR 3:** how do we assert on the installed state tree — deep-equal against a fixture, or selective path existence checks?
- **PR 4:** which spec version of `@modelcontextprotocol/conformance` do we pin, and how do we track spec-version upgrades?
- **PR 5:** do we cache `node_modules` on Windows runners, or rebuild fresh each job?
- **Post-Tier-1:** when [#1115](https://github.com/lvlup-sw/exarchos/issues/1115) lands, does the F2 CLI test run against a downloaded binary each run, or a locally-built binary served via `file://`? See [#1115 comment](https://github.com/lvlup-sw/exarchos/issues/1115#issuecomment-4277752096).

## 11. References

**Internal:**
- `docs/research/2026-04-19-e2e-testing-strategy.md` (Tier 1 framing)
- `skills/backend-quality/references/dimensions.md` (axiom dimensions DIM-1, DIM-4, DIM-5, DIM-6, DIM-7)
- `skills/verify/references/test-antipatterns.md`
- `CLAUDE.md` (architecture overview)

**External:**
- [`@modelcontextprotocol/sdk` client docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md) — `StdioClientTransport`, `Client.callTool`, `Client.listTools`
- [`@modelcontextprotocol/conformance`](https://www.npmjs.com/package/@modelcontextprotocol/conformance) — official spec conformance suite
- [`@scalvert/bin-tester`](https://github.com/scalvert/bin-tester) — CLI-in-tmpdir pattern reference
- [Vitest projects configuration](https://vitest.dev/guide/projects.html)

**Related issues:**
- [#1085](https://github.com/lvlup-sw/exarchos/issues/1085) — Windows MCP server bug (target of PR 5)
- [#1087](https://github.com/lvlup-sw/exarchos/issues/1087) — v3.0 CLI Ergonomic Infrastructure (PR 3 consumer)
- [#1088](https://github.com/lvlup-sw/exarchos/issues/1088) — HATEOAS + NDJSON output contract (F3 consumer)
- [#1098](https://github.com/lvlup-sw/exarchos/issues/1098) — Uniform HATEOAS envelope (F3 consumer)
- [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) — MCP parity cross-cutting (PR 2 + PR 4)
- [#1115](https://github.com/lvlup-sw/exarchos/issues/1115) — Universal bootstrap script (downstream of PR 3's target-agnostic design)
- [#1118](https://github.com/lvlup-sw/exarchos/issues/1118) — Codify platform-agnosticity (PR 5 rationale)
- [#1139](https://github.com/lvlup-sw/exarchos/issues/1139) — Capability resolver (future F3 work)
