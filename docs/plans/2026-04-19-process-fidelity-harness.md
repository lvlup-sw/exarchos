# Implementation Plan: Process-Fidelity Test Harness (PR 1)

## Source

Design: `docs/designs/2026-04-19-process-fidelity-harness.md`
Research: `docs/research/2026-04-19-e2e-testing-strategy.md` (Tier 1)

## Scope

**Target:** the shared fixture library only (PR 1). The four follow-up PRs (F2 MCP smoke, F2 CLI smoke, F3 conformance, Windows CI) are **out of scope** and will be planned independently after their issues are filed.

## Summary

- Total tasks: 8
- Parallel groups: 3
- Estimated test count: ~49 new tests (fixture self-tests + preflight)
- All fixture self-tests run in the `unit` project; the new `process` project ships empty and is populated by PR 2.
- Preflight check fails fast with an actionable error if `exarchos-mcp` is not on `PATH` when a `process`-project test runs (closes design §9 risk).

## Spec Traceability

| Design section | Task ID(s) | Status |
|----------------|------------|--------|
| §4.5 Vitest project split + §4.6 file layout + package.json scripts | 1 | Covered |
| §5.4 `normalize()` + §4.4 rules | 2 | Covered |
| §4.6 process-tracker (internal, consumed by tasks 5/6/7) | 3 | Covered |
| §5.1 `withHermeticEnv` | 4 | Covered |
| §5.3 `runCli` | 5 | Covered |
| §5.2 `spawnMcpClient` | 6 | Covered |
| §5.5 `expectNoLeakedProcesses` | 7 | Covered |
| §4.6 `test/setup/global.ts` + `test/fixtures/index.ts` barrel | 8 | Covered |

## Task Breakdown

### Task 1: Vitest projects split + package.json scripts

**Phase:** Infrastructure (no TDD; config only)

**Context:**
Before any fixture code lands, the build must know where fixture self-tests run (`unit`) and where the future process-fidelity tests will run (`process`). Without the split, the new `test/fixtures/**/*.test.ts` files would be picked up by the default vitest glob but couldn't be isolated.

**Steps:**

1. Update `vitest.config.ts` at repo root to define `projects`:
   ```typescript
   projects: [
     { name: 'unit',    include: ['src/**/*.test.ts', 'benchmarks/**/*.test.ts', 'scripts/**/*.test.ts', 'test/fixtures/**/*.test.ts', 'test/setup/**/*.test.ts'] },
     { name: 'process', include: ['test/process/**/*.test.ts'], testTimeout: 15000, setupFiles: ['./test/setup/global.ts'] },
   ]
   ```
   Note: `servers/exarchos-mcp/**` is intentionally NOT included — that workspace has its own deps and its own CI job. Including it here would force root `npm ci` to install the MCP server's deps and break Root Package CI.
2. Update root `package.json` scripts:
   ```
   "test:unit":    "vitest run --project unit",
   "test:process": "vitest run --project process --passWithNoTests",
   "test:all":     "vitest run",
   "test:run":     "npm run test:unit"   // preserve existing CI behavior
   ```
3. Create empty directory `test/process/.gitkeep` and `test/fixtures/` so globs resolve.
4. Run `npm run test:unit` — all existing tests must pass unchanged.
5. Run `npm run test:process` — must exit 0 with "no test files found" (expected; populated by PR 2).

**Verification:**
- [ ] Existing test count unchanged after config split (no regressions).
- [ ] `npm run test:process` exits 0.
- [ ] `npm run test:all` exits 0 and runs every project.

**Dependencies:** None
**Parallelizable:** No (everyone depends on this)

---

### Task 2: `normalize()` — timestamps, sequences, paths, UUIDs, request IDs, idempotence

**Phase:** RED → GREEN

**Context:**
Pure function. Walks any JSON-serializable value and replaces non-deterministic fields with canonical placeholders. The five rules in design §4.4 are the PR 1 minimum. The `Normalized<T>` type is structural.

**TDD Steps:**

1. [RED] Write tests in `test/fixtures/normalizers.test.ts`:
   - `Normalize_IsoTimestamp_ReplacesWithPlaceholder`
   - `Normalize_NestedIsoTimestamp_ReplacesWithPlaceholder`
   - `Normalize_EventSequenceField_ReplacesWithSeqPlaceholder`
   - `Normalize_SequenceField_ReplacesWithSeqPlaceholder`
   - `Normalize_AbsoluteTmpPath_ReplacesWithWorktreePlaceholder`
   - `Normalize_NonTmpAbsolutePath_LeavesUnchanged`
   - `Normalize_UuidV4_ReplacesWithUuidPlaceholder`
   - `Normalize_McpRequestId_ReplacesWithReqIdPlaceholder`
   - `Normalize_Idempotent_SecondCallIsNoOp`
   - `Normalize_DeepNestedStructure_ReplacesAllMatches`
   - `Normalize_NullAndUndefined_PassThroughUnchanged`
   - `Normalize_PrimitiveString_ReplacesIfMatchesPattern`
   - File: `test/fixtures/normalizers.test.ts`
   - Run: `npx vitest run --project unit test/fixtures/normalizers.test.ts` — MUST FAIL (module missing)

2. [GREEN] Implement `test/fixtures/normalizers.ts`:
   - Export `normalize<T>(value: T): Normalized<T>`.
   - Internal regex table: `ISO_8601_RE`, `UUID_V4_RE`.
   - Key-based rules: `_eventSequence`, `sequence` → `<SEQ>`.
   - Path rule: match any string starting with the current OS tmp dir root.
   - Request-ID rule: match within an object where sibling `jsonrpc === '2.0'` (structural, not regex).
   - Use `structuredClone` then walk+mutate for clarity.
   - Run: `npx vitest run --project unit test/fixtures/normalizers.test.ts` — MUST PASS.

3. [REFACTOR] If the walker grows beyond ~60 lines, extract rules to a small rule table. Otherwise inline.

**Verification:**
- [ ] All 12 tests pass.
- [ ] Idempotence test specifically asserts `normalize(normalize(x)) === normalize(x)` (deep equal).

**Dependencies:** Task 1
**Parallelizable:** Yes (Group A)

---

### Task 3: process-tracker internal module

**Phase:** RED → GREEN

**Context:**
Internal registry of spawned children. Consumed by `runCli` (registers), `spawnMcpClient` (registers), and `expectNoLeakedProcesses` (reads + force-kills). Not part of the public API; no barrel export. Module-scoped mutable state is acceptable here because the test runner provides process isolation per vitest worker.

**TDD Steps:**

1. [RED] Write tests in `test/fixtures/process-tracker.test.ts`:
   - `ProcessTracker_Register_AddsChildToList`
   - `ProcessTracker_Unregister_RemovesChild`
   - `ProcessTracker_ListAlive_OnlyReturnsRunningChildren`
   - `ProcessTracker_KillAll_SendsSigtermThenSigkill`
   - `ProcessTracker_Clear_EmptiesList`
   - `ProcessTracker_RegisterSameChildTwice_Idempotent`
   - File: `test/fixtures/process-tracker.test.ts`
   - Use `child_process.spawn('node', ['-e', 'setInterval(()=>{}, 1000)'])` for long-lived test children; `spawn('node', ['-e', ''])` for quick-exit children.
   - Run: MUST FAIL (module missing)

2. [GREEN] Implement `test/fixtures/process-tracker.ts`:
   - Module-level `Set<ChildProcess>`.
   - `register(child)`, `unregister(child)`, `listAlive()`, `killAll({ timeoutMs })`, `clear()`.
   - `killAll` sends SIGTERM, waits up to `timeoutMs` (default 3000), then SIGKILL on survivors.
   - Run: MUST PASS.

**Verification:**
- [ ] Long-lived child process killed cleanly within 3 seconds of `killAll`.
- [ ] `listAlive()` returns 0 after all children exit naturally.

**Dependencies:** Task 1
**Parallelizable:** Yes (Group A)

---

### Task 4: `withHermeticEnv`

**Phase:** RED → GREEN → REFACTOR

**Context:**
Single-mode per design §4.3. Creates `tmp/<id>/{home,state,cwd,git}/`, sets env + CWD, runs callback, unconditionally cleans up. No mode flag. Concurrent callers must get non-overlapping tmp dirs (test-id derived from a counter or randomUUID, not timestamp).

**TDD Steps:**

1. [RED] Write tests in `test/fixtures/hermetic.test.ts`:
   - `WithHermeticEnv_Success_ProvidesFreshHomeAndStateAndCwd`
   - `WithHermeticEnv_CallbackThrows_StillCleansUp`
   - `WithHermeticEnv_CallbackSucceeds_RestoresOriginalHomeAndCwd`
   - `WithHermeticEnv_ConcurrentCallers_GetNonOverlappingTmpDirs`
   - `WithHermeticEnv_EnvVarsSet_HomeAndStateDirMatchTmp`
   - `WithHermeticEnv_GitInit_TmpGitIsRepository`
   - `WithHermeticEnv_CleanupRace_DoesNotFailTest` (simulates locked file; cleanup logs warning but doesn't throw)
   - File: `test/fixtures/hermetic.test.ts`
   - Use `fs.existsSync` for post-cleanup assertions; the test must observe tmp dir is gone after callback returns.
   - Run: MUST FAIL.

2. [GREEN] Implement `test/fixtures/hermetic.ts`:
   - Export `withHermeticEnv<T>(callback): Promise<T>` and `HermeticEnv` interface.
   - Use `crypto.randomUUID()` for `testId`.
   - Use `os.tmpdir()` as root; `tmp/<testId>/{home,state,cwd,git}/` structure.
   - `git init` via `child_process.execFile('git', ['init', '-q', gitDir])`.
   - Save/restore `process.env.HOME`, `process.env.EXARCHOS_STATE_DIR`, `process.cwd()`.
   - `finally` block: `fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 })`; swallow cleanup errors with `console.warn`.
   - Run: MUST PASS.

3. [REFACTOR] Extract tmp-path construction to a helper if more than one call site needs it. Otherwise inline.

**Verification:**
- [ ] All 7 tests pass.
- [ ] Cleanup failure mode (simulated locked file) does NOT fail the test — only warns.
- [ ] 100 concurrent `withHermeticEnv` calls produce 100 distinct `tmp/<id>/` dirs.

**Dependencies:** Task 1
**Parallelizable:** Yes (Group A)

---

### Task 5: `runCli`

**Phase:** RED → GREEN

**Context:**
Target-agnostic CLI invoker per design §4.2. Takes `{ command, args, env, cwd, stdin, timeout }` and returns `{ stdout, stderr, exitCode, durationMs }`. Non-zero exit does NOT throw — always returns structured result. Only timeout throws. Registers the spawned process with process-tracker for leak detection.

**TDD Steps:**

1. [RED] Write tests in `test/fixtures/cli-runner.test.ts`:
   - `RunCli_SuccessfulCommand_ReturnsZeroExitCode`
   - `RunCli_NonZeroExit_ReturnsStructuredResultNotThrow`
   - `RunCli_CapturesStdoutAndStderr_Separately`
   - `RunCli_Stdin_PipesToChild`
   - `RunCli_Timeout_RejectsAndKillsChild`
   - `RunCli_EnvOverride_MergedWithCurrentEnv`
   - `RunCli_Cwd_SpawnsChildInGivenDirectory`
   - `RunCli_Duration_ReportedInMilliseconds`
   - `RunCli_RegistersWithProcessTracker_UnregistersOnExit`
   - File: `test/fixtures/cli-runner.test.ts`
   - Use `node -e '<inline script>'` as the command under test to avoid depending on any binary.
   - Run: MUST FAIL.

2. [GREEN] Implement `test/fixtures/cli-runner.ts`:
   - Use `child_process.spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })`.
   - Register with `process-tracker.register(child)` immediately.
   - Accumulate stdout/stderr via event listeners.
   - Write `stdin` if provided, then close stdin.
   - Race process `close` event against `setTimeout(timeout)`.
   - On timeout: SIGKILL child, reject with `CliTimeoutError`.
   - On close: unregister from tracker, resolve with `{ stdout, stderr, exitCode, durationMs }`.
   - Run: MUST PASS.

**Verification:**
- [ ] All 9 tests pass.
- [ ] Tracker-registration test specifically verifies `listAlive()` reflects running child and is empty after resolve.

**Dependencies:** Tasks 1, 3
**Parallelizable:** Yes with Tasks 6, 7 (Group B)

---

### Task 6: `spawnMcpClient`

**Phase:** RED → GREEN

**Context:**
Spawns the MCP server binary and returns a connected `Client`. Default command is `exarchos-mcp` (npm-link-resolved). For this PR's self-tests, use a minimal mock MCP server written in the test file (not a separate fixture) — this isolates the harness test from dependencies on `exarchos-mcp`'s actual behavior.

**TDD Steps:**

1. [RED] Write tests in `test/fixtures/mcp-client.test.ts`:
   - `SpawnMcpClient_MockServer_ConnectsAndListsTools`
   - `SpawnMcpClient_CallToolOnMockServer_ReturnsExpectedContent`
   - `SpawnMcpClient_ServerExitsBeforeInitialize_RejectsWithStderr`
   - `SpawnMcpClient_InitTimeout_RejectsCleanly`
   - `SpawnMcpClient_TerminateIdempotent_CanCallTwice`
   - `SpawnMcpClient_StderrCapture_AccessibleOnSpawnedMcpClient`
   - `SpawnMcpClient_RegistersWithProcessTracker_UnregistersAfterTerminate`
   - File: `test/fixtures/mcp-client.test.ts`
   - Include a minimal mock server inline or in `test/fixtures/__helpers__/mock-mcp-server.mjs`:
     ```typescript
     // Uses @modelcontextprotocol/sdk to register one 'echo' tool and run on stdio
     ```
   - Run: MUST FAIL.

2. [GREEN] Implement `test/fixtures/mcp-client.ts`:
   - Import `StdioClientTransport` and `Client` from `@modelcontextprotocol/sdk`.
   - `SpawnMcpClientOpts` defaults: `command = 'exarchos-mcp'`, `timeout = 10000`.
   - Construct transport, construct client, `await client.connect(transport)` with timeout race.
   - Register child (obtained via transport internals or by spawning separately and passing stdio) with process-tracker.
   - Capture stderr into `stderr: string[]` array.
   - If process exits during connect, reject with captured stderr.
   - `terminate()`: call `client.close()`, wait for exit, force-kill after 3s; idempotent via guard flag.
   - Run: MUST PASS.

3. [REFACTOR] If the connect/stderr/exit race becomes more than ~40 lines, extract to a `connectWithTimeout` helper. Otherwise inline.

**Verification:**
- [ ] All 7 tests pass.
- [ ] Tests pass via mock server, independent of any `exarchos-mcp` state.
- [ ] Tracker registration verified.

**Dependencies:** Tasks 1, 3
**Parallelizable:** Yes with Tasks 5, 7 (Group B)

---

### Task 7: `expectNoLeakedProcesses`

**Phase:** RED → GREEN

**Context:**
Global `afterEach` helper. Reads process-tracker's alive list. If non-empty, force-kills leaks and fails the current test with a descriptive error. Per design §5.5.

**TDD Steps:**

1. [RED] Write tests in `test/fixtures/leak-detector.test.ts`:
   - `ExpectNoLeakedProcesses_NoAliveChildren_Passes`
   - `ExpectNoLeakedProcesses_LiveChildRemaining_ThrowsAndForceKills`
   - `ExpectNoLeakedProcesses_AfterKill_TrackerIsEmpty`
   - `ExpectNoLeakedProcesses_ErrorMessage_IncludesChildPidAndCommand`
   - File: `test/fixtures/leak-detector.test.ts`
   - Use long-lived `child_process.spawn('node', ['-e', 'setInterval(()=>{}, 1000)'])` to simulate a leak.
   - Run: MUST FAIL.

2. [GREEN] Implement `test/fixtures/leak-detector.ts`:
   - Export `expectNoLeakedProcesses(): void`.
   - Read `processTracker.listAlive()`.
   - If non-empty: call `processTracker.killAll({ timeoutMs: 3000 })`, then `throw new Error(...)` describing leaks.
   - Run: MUST PASS.

**Verification:**
- [ ] All 4 tests pass.
- [ ] Leak message includes each child's PID and the original command (stored on register).

**Dependencies:** Tasks 1, 3
**Parallelizable:** Yes with Tasks 5, 6 (Group B)

---

### Task 8: Global setup + preflight + barrel export

**Phase:** Infrastructure wiring (TDD on the preflight; no TDD on glue)

**Context:**
Three things: (a) a preflight check that fails the `process` project fast with an actionable error if `exarchos-mcp` is not resolvable on `PATH` (closes design §9 risk "`npm link` non-determinism"); (b) an `afterEach` hook running `expectNoLeakedProcesses` in the `process` project only; (c) the public-API barrel. This task lands only after Tasks 2–7 are complete.

**TDD steps for preflight:**

1. [RED] Write tests in `test/setup/preflight.test.ts` (runs in `unit` project):
   - `AssertExarchosMcpOnPath_BinaryResolvable_DoesNotThrow`
   - `AssertExarchosMcpOnPath_BinaryMissing_ThrowsActionableError` (error message must include "npm link" hint)
   - `AssertExarchosMcpOnPath_CustomCommand_UsesOverride` (accepts `command` arg for testability)
   - File: `test/setup/preflight.test.ts`
   - Use a sentinel command like `exarchos-mcp-definitely-not-real` to force the missing-binary path.
   - Run: MUST FAIL (module missing).

2. [GREEN] Implement `test/setup/preflight.ts`:
   - Export `assertExarchosMcpOnPath(command = 'exarchos-mcp'): void`.
   - Use `child_process.execFileSync('node', ['-e', \`require('child_process').execFileSync('${command}', ['--version'])\`])` or simpler `which`/`where` platform-aware resolution. Fail loudly with a message that says: *"exarchos-mcp not found on PATH. Run `npm link` in the repo root before running the process project. See docs/designs/2026-04-19-process-fidelity-harness.md §4.2."*
   - Run: MUST PASS.

**Glue steps (no TDD):**

3. Create `test/setup/global.ts`:
   ```typescript
   import { afterEach } from 'vitest';
   import { expectNoLeakedProcesses } from '../fixtures/leak-detector.js';
   import { assertExarchosMcpOnPath } from './preflight.js';

   // Fail fast before any test runs in this project.
   assertExarchosMcpOnPath();

   afterEach(() => { expectNoLeakedProcesses(); });
   ```
   Vitest runs setupFiles module-body code once per worker before tests execute. The preflight therefore fails fast before PR 2's first test runs, without penalizing an empty `process` project (vitest does not execute setupFiles when zero tests are discovered).

4. Update `vitest.config.ts` to reference setupFiles for the `process` project only:
   ```typescript
   { name: 'process', include: [...], testTimeout: 15000, setupFiles: ['./test/setup/global.ts'] }
   ```
   Note: the `unit` project does NOT get this setup — fixture self-tests manage their own lifecycle explicitly, and adding a global afterEach to them would create order-of-teardown fragility.

5. Create `test/fixtures/index.ts` barrel:
   ```typescript
   export { withHermeticEnv, type HermeticEnv } from './hermetic.js';
   export { spawnMcpClient, type SpawnMcpClientOpts, type SpawnedMcpClient } from './mcp-client.js';
   export { runCli, type RunCliOpts, type CliResult } from './cli-runner.js';
   export { normalize, type Normalized } from './normalizers.js';
   export { expectNoLeakedProcesses } from './leak-detector.js';
   ```
   Note: `process-tracker` and `preflight` are deliberately NOT re-exported — internal only.

6. Add a barrel smoke test at `test/fixtures/index.test.ts`:
   - `Barrel_ImportsAllPublicApi_AndNothingMore`
   - Asserts `Object.keys(fixtures)` equals the exact expected set.

7. Run `npm run test:all` — everything must pass. Run `npm run test:process` — must still pass with zero tests (setupFiles not triggered on empty project).

**Verification:**
- [ ] Preflight tests pass (3 tests).
- [ ] Barrel exports exactly 5 symbols + 6 types (HermeticEnv, SpawnMcpClientOpts, SpawnedMcpClient, RunCliOpts, CliResult, Normalized).
- [ ] `process-tracker` and `preflight` are not accessible from the barrel.
- [ ] Global afterEach only registered for the `process` project, not `unit`.
- [ ] When PR 2 adds its first test, running `test:process` without prior `npm link` must produce the actionable preflight error. Verify manually by simulating: `env PATH=/usr/bin npm run test:process` after PR 2 lands — must fail with the documented message.

**Dependencies:** Tasks 2, 3, 4, 5, 6, 7
**Parallelizable:** No (consolidation step)

---

## Parallelization Strategy

```
Task 1 (infrastructure)
   ↓
┌──────────────────────────────┐
│ Group A (parallel):          │
│   Task 2  normalize          │
│   Task 3  process-tracker    │
│   Task 4  withHermeticEnv    │
└──────────────────────────────┘
   ↓ (Group A completes)
┌──────────────────────────────┐
│ Group B (parallel):          │
│   Task 5  runCli             │  needs Task 3
│   Task 6  spawnMcpClient     │  needs Task 3
│   Task 7  expectNoLeaked     │  needs Task 3
└──────────────────────────────┘
   ↓ (Group B completes)
Task 8 (wrap-up: setup file + barrel)
```

Task 2 has no dependency on Task 3 and could notionally run in Group B, but keeping it in Group A (with withHermeticEnv) balances the parallel load across three groups of similar difficulty.

## Deferred Items

All belong to follow-up PRs, tracked as separate issues per design §7:

| Item | Target PR |
|------|-----------|
| First F2 MCP smoke test (`exarchos_workflow` round-trip over stdio) | PR 2 |
| First F2 CLI smoke test (`exarchos install` against tmp `$HOME`) | PR 3 |
| `@modelcontextprotocol/conformance` integration as `conformance` vitest project | PR 4 |
| Windows CI runner on `unit` project | PR 5 |
| Per-action parity-contract schema | PR 4 design |
| Bootstrap-binary target for `runCli` (consumes [#1115](https://github.com/lvlup-sw/exarchos/issues/1115)) | Post-Tier-1 |

## Motivation-to-PR Traceability

Design §2 lists five failure modes this strategy exists to detect. PR 1 ships no wire-level tests by construction — it is the test-infrastructure layer. Each motivation item is owned by a specific follow-up PR, and that PR's design / acceptance criteria must explicitly close it.

| Design §2 motivation | Owning PR | Must include |
|----------------------|-----------|--------------|
| "A server that fails to start because of a missing runtime flag passes every in-process handler test." | PR 2 | A test that asserts the default `spawnMcpClient()` successfully completes `initialize` against the built binary, i.e. the server starts cleanly as shipped. |
| "A regression in the `bin` wrapper passes every CLI function test." | PR 3 | A test that invokes `exarchos-install` via `runCli`, not via in-process function call, so the shebang and `bin` wrapper are exercised. |
| "A Zod-schema change that breaks JSON-RPC tool-call parsing passes every unit test." | PR 2 | A test that issues a well-formed `tools/call` over stdio with one known-good argument set and one known-bad argument set, asserting the server's JSON-RPC error response matches the Zod-derived error shape. |
| "A Windows-specific `path.resolve` bug ships undetected, because CI is Linux-only." | PR 5 | `windows-latest` added to the `unit` project CI matrix. Closes the specific bug class in [#1085](https://github.com/lvlup-sw/exarchos/issues/1085). |
| "The 'MCP parity' contract in [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) has no operational definition, because no test compares CLI output to MCP output." | PR 4 | At least one parity test for one action, plus the per-action parity-contract schema design. |

This table must be copied into each follow-up PR's design as an acceptance criterion, so the motivation items cannot silently drop between PRs.

## Completion Checklist

- [ ] Task 1: vitest projects configured; `npm run test:unit` and `npm run test:process` resolve.
- [ ] Task 2: `normalize()` covers all 5 rules + idempotence; 12 tests pass.
- [ ] Task 3: process-tracker has register/unregister/listAlive/killAll/clear; 6 tests pass.
- [ ] Task 4: `withHermeticEnv` isolates env/CWD/FS; cleanup unconditional; 7 tests pass.
- [ ] Task 5: `runCli` returns structured result; timeout handled; 9 tests pass.
- [ ] Task 6: `spawnMcpClient` connects via stdio; stderr captured; terminate idempotent; 7 tests pass.
- [ ] Task 7: `expectNoLeakedProcesses` detects + force-kills leaks; 4 tests pass.
- [ ] Task 8: preflight tests pass (3); global setup wired (process project only); barrel exports exactly the public API; motivation-to-PR traceability table copied into follow-up PR designs.
- [ ] `npm run test:all` passes.
- [ ] Existing test count preserved (no F1 regressions).
- [ ] Four follow-up GitHub issues filed per design §7; each folded into the correct v3.0 milestone.
- [ ] PR description links back to this design and the research doc.
