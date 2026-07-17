# Design: E2E Tests for v2.9.0 — Revisited Process-Fidelity Series

**Status:** Design (ideate phase). Implementation plan will follow.
**Workflow:** `e2e-v29-revisited`
**Date:** 2026-05-05
**Supersedes (in part):** `docs/designs/2026-04-19-process-fidelity-harness.md` — keeps the foundation, restructures the follow-up sequence.
**Source research:** `docs/research/2026-04-19-e2e-testing-strategy.md` (Tier 1, with one named extension to F6).

## 1. Summary

The original 2026-04-19 design specified a 5-PR series rooted in **F2 process fidelity** (real binary over real stdio) and **F3 protocol fidelity** (`@modelcontextprotocol/conformance` + per-action parity). PR 1 of that series — the shared fixture library — landed as PR #1166 and remains open and mergeable but unmerged; PRs 2–5 were never opened.

In the intervening ~17 days the project shipped the v2.9 install rewrite (single bun-compiled `exarchos` binary), event-sourced rehydrate-foundation, capability-aware delegation across five runtimes, and an autonomous merge orchestrator, then proceeded through three release candidates whose dogfooding produced 8+ filed bugs. **None of the rc.1–rc.3 bugs would have been caught by the original 5-PR series**, because they are not F2/F3 surface failures — they are F6 saga-semantics and event-sourcing-reconstructability failures (e.g. #1208 HSM detour absent, #1206 projection counts unfiltered, #1180 rehydrate `taskProgress` empty without `task.assigned`).

This design restructures the v2.9.0 e2e work into **6 PRs across two milestones** (4 ship in v2.9.0 GA; 2 defer to v2.10), reordered around dogfood ROI rather than original sequence:

- **P1** carries the foundation forward (rebase #1166, retarget at the v2.9 binary surface).
- **P2** is **net-new** — an F6 saga harness whose first regression test is the #1208 HSM detour.
- **P3** narrows the original PR4 to the parity half that operationally proves #1109 invariant #2 (CLI ↔ MCP envelope equivalence).
- **P4** is the original PR3 expanded — broader CLI surface coverage (install-rewrite + diagnostic + introspection), retargeted at the v2.9 single binary.
- **P5** (Windows runner across `unit` + `process`) and **P6** (full `@modelcontextprotocol/conformance`) defer to v2.10.

The design promotes **event-sourcing reconstructability** from an implicit Tier-3 F6 sub-concern to a named first-class invariant (call it **F6.1**) tested by P2 and exercised by P3.

## 2. Problem

### 2.1 The original design no longer matches the failure modes we observed

The original 5-PR series targeted DIM-3 + DIM-4 at the process and wire boundaries. The dogfood bugs filed during rc.1–rc.3 are mostly DIM-1 (HSM topology / projection wiring) and DIM-3 (skill-doc-as-contract drift) and would have escaped the original tests:

| Bug | Failure mode | Class | Caught by original 5-PR? |
|-----|-------------|-------|--------------------------|
| #1208 | `task.completed{worktreePath}` does not surface `merge_orchestrate` in `next_actions` | F6 saga semantics | No |
| #1206 | `prepare_delegation` `worktrees.expected` counts all `task.assigned` events, ignores wave filter | F6 + event-replay | No |
| #1205 | `prepare_delegation` "plan artifact missing" diverges from `delegation_readiness` view | F6 + projection parity | No |
| #1209 | `setup_worktree` ignores planned branch name; hardcodes `feature/<id>-<name>` | F6 contract drift | No |
| #1180 / #1179 | Rehydrate `taskProgress` projection silently empty without `task.assigned` events | F6 + event-sourcing reconstructability | No |
| #1085 (historical) | Windows symlink/junction MCP server bug | F4 platform | Yes (PR5) |

Five of six are saga-semantics or event-sourcing failures. PR2's original "single MCP `tools/call` round-trip" smoke would have returned `isError: false` for every one.

### 2.2 The binary surface the design assumed no longer exists

The original PR1 (#1166) specified `runCli({ command: 'exarchos-install', ... })` with the comment "the `npm link`-resolved binary". The v2.9 install rewrite (`b9297d40`) replaced this entire model:

- There is one binary, `exarchos`, built by `scripts/build-binary.ts` via `bun build --compile`.
- Subcommand surface is **10+ commands** (see §4.4) including `install-skills`, `doctor`, `init`, `merge-orchestrate`, `schema`, `topology`, `emissions`, `mcp`, `version`, plus a generic `exarchos <action>` dispatch that auto-generates from MCP tool actions.
- There is no separate `exarchos-install` binary. The install rewrite renamed the surface; the design's call sites need retargeting.

### 2.3 Cross-cutting #1109 has invariants the original design didn't address

#1109 codifies four invariants for every v3.0+ surface:

1. **Event-sourcing integrity** — output reconstructible from events alone.
2. **MCP parity** — CLI and MCP facades produce identical envelopes.
3. **Basileus-forward** — no MCP-as-second-class assumptions.
4. **Capability resolution** — yaml ⊕ handshake merge, handshake-authoritative.

The original design covered #2 (PR4 parity sub-component) and partially #4 (deferred to #1139 follow-up). #1 was implicit in deferred F6 only. None of the original 5 PRs would have produced a test asserting #1.

## 3. Scope

### 3.1 In scope for v2.9.0 GA (this design — 4 PRs)

- **P1** — Foundation rebase + retarget (carries forward #1166 with v2.9-binary edits).
- **P2** — F6 saga harness + first regression test (#1208 HSM detour).
- **P3** — F3 narrowed: projection-equivalence parity + event-replay primitive.
- **P4** — Broader CLI surface smoke (P4b scope: `install-skills`, `doctor`, `version`, `schema`, `topology`, `emissions`, `mcp` start-and-shutdown).

### 3.2 In scope for v2.10 (this design's follow-ups — 2 PRs)

- **P5** — F4 Windows CI runner across `unit` + `process` projects (one notch broader than the original PR5's `unit`-only).
- **P6** — Full `@modelcontextprotocol/conformance` integration as `conformance` vitest project (the conformance half of the original PR4, narrower than originally scoped because P3 already covers parity).

### 3.3 Out of scope entirely (unchanged from 2026-04-19 §3.3)

Tier 2 / Tier 3 work: macOS runner, F4 platform probes (case sensitivity, line endings), F5 per-runtime install fixtures, full F6 lifecycle saga covering `synthesize → cleanup`, LLM-driven conversation tests (`mcpjam`).

## 4. Architecture

### 4.1 Carry-forward from 2026-04-19

The following architectural decisions from the original design carry forward unchanged into P1; this design does **not** revisit them:

- Library shape: procedural functional, four+one top-level exports (§4.1 of original).
- Hermeticity model: single-mode, unconditional `finally` cleanup (§4.3).
- Vitest project split: `unit` | `integration` | `process` (§4.5). v2.10 P6 adds `conformance`.
- File layout under `test/fixtures/`, `test/process/`, `test/setup/` (§4.6).
- Public API of `withHermeticEnv`, `spawnMcpClient`, `runCli`, `normalize`, `expectNoLeakedProcesses` (§5).

The minimum-viable five normalizer rules from the original §4.4 carry forward; P3 extends them.

### 4.2 New: F6.1 event-sourcing reconstructability as a named primitive

Promote the implicit sub-concern from the original strategy doc §F6 to a first-class testable invariant. Two new fixture primitives:

```typescript
// test/fixtures/event-replay.ts
export async function snapshotEventStream(
  client: SpawnedMcpClient,
  featureId: string,
): Promise<EventSnapshot>;

export async function replayInto(
  client: SpawnedMcpClient,
  snapshot: EventSnapshot,
): Promise<void>;
```

`snapshotEventStream` calls `exarchos_view({ action: 'event_log', featureId })` and freezes the result with `normalize` applied. `replayInto` re-emits the snapshot's events into a freshly-spawned MCP server's state dir and returns when projections are caught up (defined as: `exarchos_view({ action: 'rehydrate' })` returns the same projection shape as the snapshot's source).

Rationale (axiom-grounded):
- **DIM-1:** event store is the composition root; projections derive. The primitive makes that wiring testable.
- **DIM-3:** the event log is the contract; the projection is a derivative. Asserting reconstructability is asserting the contract holds.
- **DIM-4:** without this, the F6 lifecycle test cannot distinguish "projection broken" from "events not emitted" — the #1180/#1206 failure mode.

### 4.3 New: parity normalizer — projection-equivalence

P3 adds an extension to `normalize` that handles facade-specific differences between CLI and MCP envelopes (whitespace, JSON-key ordering at the envelope boundary, transport-specific request IDs). Per-action parity tolerance is declared in `test/fixtures/parity-contract.ts`:

```typescript
// test/fixtures/parity-contract.ts
export type ParitySpec = {
  action: string;
  fieldsRequiringEquality: string[];      // dot-paths into the envelope
  fieldsAllowedToDiffer: string[];        // e.g. ['_transport.requestId']
};

export const PARITY_CONTRACT: ParitySpec[] = [/* per-action entries */];

export function assertParity(cliResult: unknown, mcpResult: unknown, spec: ParitySpec): void;
```

The contract starts with `view.describe`, `view.event_log`, `view.rehydrate` — the three actions whose CLI and MCP shapes are most directly compared by the dogfood pattern.

### 4.4 P4 CLI surface coverage matrix

| Subcommand | What P4 asserts | Why |
|------------|-----------------|-----|
| `exarchos version` | Stdout matches `package.json` version | Sanity smoke; binary self-identification |
| `exarchos doctor` | Exit 0 in clean tmp `$HOME`; structured output enumerates expected checks | Preflight contract — high-signal cross-platform regression detector |
| `exarchos install-skills --agent claude` | After invocation, expected files exist under `tmp/$HOME/.claude/`; `~/.claude.json` contains MCP registration | Install rewrite primary surface; would have caught #1085-class |
| `exarchos schema [ref]` | JSON output parses; every action listed in MCP `tools/list` is enumerable | Contract introspection — proves CLI and MCP agree on the action surface |
| `exarchos topology [type]` | JSON output parses; topology graph contains expected node count | Introspection |
| `exarchos emissions` | JSON output parses; emissions catalog non-empty | Introspection |
| `exarchos mcp` (start, then SIGTERM) | Process starts, accepts a single `initialize` over stdin/stdout, exits cleanly on SIGTERM within 3s | Mode-dispatch contract; every other test depends on this working |

P4 does **not** cover `init`, `merge-orchestrate`, or generic `<action>` dispatch via CLI — those are covered by P2 (saga, MCP-side) and P3 (parity, both sides).

### 4.5 PR sequencing

```
P1 (rebase #1166)           P2 (F6 saga harness)        P3 (F3 parity narrowed)
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│ Foundation           │───▶│ snapshotEventStream  │───▶│ assertParity         │
│ retargeted at v2.9   │    │ replayInto           │    │ parity-contract.ts   │
│ binary; CR fixes     │    │ + #1208 regression   │    │ + view.* parity tests│
└──────────────────────┘    └──────────────────────┘    └──────────────────────┘
         │                            │                          │
         │                            │                          │
         └─▶ P4 (broader CLI)         │                          │
            ┌──────────────────────┐  │                          │
            │ install-skills,      │  │                          │
            │ doctor, schema,      │  │                          │
            │ topology, emissions, │  │                          │
            │ mcp start/stop, ver  │  │                          │
            └──────────────────────┘  │                          │
                                                                 │
                  ─── v2.9.0 GA cut line ───                     │
                                                                 │
                          ▼                          ▼
                  P5 (v2.10)                  P6 (v2.10)
                  ┌──────────────────────┐    ┌──────────────────────┐
                  │ Windows matrix:      │    │ @modelcontextprotocol│
                  │ unit + process       │    │ /conformance as      │
                  │ projects             │    │ vitest project       │
                  └──────────────────────┘    └──────────────────────┘
```

P1 is a strict prerequisite. P2, P3, P4 are independent of each other after P1 lands and may be developed in parallel; the recommended merge order is P2 → P4 → P3 because P3 leans hardest on the normalizer and benefits from any extensions P2/P4 add first.

## 5. Per-PR specifications

### 5.1 P1 — Foundation rebase + v2.9 retarget

**Goal:** unblock the harness for downstream PRs.

**Deltas vs original PR1:**

- Rebase against current `main`. Current `main` has no `test/fixtures/` or `test/process/` dirs, so the rebase is mechanical except for `package.json` script collisions and `vitest.config.ts` evolution.
- Address coderabbitai actionable comments (15 outstanding); spec-review and quality-review verdicts already PASS/APPROVED on the original PR.
- Retarget `runCli` defaults: change documentation and example call sites from `command: 'exarchos-install'` to `command: 'exarchos'` with explicit subcommand args. The function signature does not change.
- Retarget `spawnMcpClient`: server is now `exarchos mcp`, not a separate `exarchos-mcp` binary. Update preflight `assertExarchosMcpOnPath()` to assert `exarchos` resolvable (this is what `npm link` produces from the bun-compiled binary install).
- Add a check in preflight that the binary at `$(which exarchos)` advertises a v2.9.x version, to fail fast when the developer's local install is stale.

**Acceptance:**
- All 49 fixture self-tests still pass.
- `test:process` directory remains empty but the project loads and exits 0 (PR2 adds the first test).
- Iron Law (RED→GREEN per file) preserved.

**Effort:** ~1 week (most time goes to addressing coderabbit comments + verifying retarget against the bun binary).

### 5.2 P2 — F6 saga harness + #1208 regression

**Goal:** ship the test that would have caught the rc.1 worst bug.

**New fixtures (extend `test/fixtures/`):**
- `event-replay.ts` — `snapshotEventStream`, `replayInto` (§4.2).
- `saga-driver.ts` — thin sequencer that takes an array of `{ action, args }` calls, drives them against a `SpawnedMcpClient`, captures the event stream after each step, returns a transcript.

**New test (`test/process/saga-merge-detour.test.ts`):**

```typescript
it('task.completed{worktreePath} surfaces merge_orchestrate in next_actions', async () => {
  await withHermeticEnv(async (env) => {
    const mcp = await spawnMcpClient({ stateDir: env.stateDir });
    try {
      await driveSaga(mcp.client, [
        { action: 'workflow', args: { action: 'init', featureId: 'p2-detour', workflowType: 'feature' } },
        { action: 'orchestrate', args: { action: 'prepare_delegation', featureId: 'p2-detour', tasks: [/* 1 task */] } },
        { action: 'event', args: { action: 'emit', type: 'task.assigned', data: { taskId: '001', branch: 'feature/p2-detour-001' } } },
        { action: 'orchestrate', args: { action: 'task_complete', taskId: '001', result: { worktreePath: env.gitDir } } },
      ]);
      const view = await mcp.client.callTool({ name: 'exarchos_view', arguments: { action: 'rehydrate', featureId: 'p2-detour' } });
      expect(view.content).toMatchObject({ next_actions: expect.arrayContaining([expect.objectContaining({ verb: 'merge_orchestrate' })]) });
    } finally {
      await mcp.terminate();
    }
  });
});
```

This test fails on current `main` (#1208 is open). The PR includes both the test and the fix; merging it closes #1208.

**Out-of-scope for P2:** any saga past `merge_orchestrate`; multi-wave dispatch (folded into P3 follow-up); compensation paths.

**Effort:** ~1 week.

### 5.3 P3 — F3 narrowed: projection-equivalence parity + event-replay

**Goal:** operationally prove #1109 invariant #2 (MCP parity) and invariant #1 (event-sourcing integrity) for the three highest-leverage view actions.

**New fixtures:**
- `parity-contract.ts` — per-action parity spec (§4.3).
- Extension to `normalize`: per-facade key-ordering canonicalization, transport-id stripping.

**New tests (`test/process/parity-*.test.ts`):**
- `parity-view-describe.test.ts` — drive a 3-step saga, then assert `exarchos describe <featureId>` (CLI) and `exarchos_view({ action: 'describe', featureId })` (MCP) produce equal envelopes after normalize + parity-contract field selection.
- `parity-view-event-log.test.ts` — same shape, action `event_log`.
- `parity-view-rehydrate.test.ts` — same shape, action `rehydrate`. **This test also asserts F6.1 reconstructability**: after `snapshotEventStream` of the original run + `replayInto` a fresh MCP server, the rehydrate projection is structurally equal.

**Acceptance:**
- All three parity tests pass.
- `parity-contract.ts` is the single source of truth for parity tolerance; no per-test exceptions.
- Reconstructability test is wired in `test/process/` and runs on PR gate.

**Effort:** ~1 week (most goes to the normalizer extensions and parity-contract design).

### 5.4 P4 — Broader CLI surface (P4b scope)

**Goal:** prove the v2.9 install-rewritten binary's published subcommand surface works end-to-end on Linux.

**Surface coverage:** §4.4 matrix.

**Test layout:**
```
test/process/cli/
├── version.test.ts
├── doctor.test.ts
├── install-skills.test.ts
├── schema.test.ts
├── topology.test.ts
├── emissions.test.ts
└── mcp-start-stop.test.ts
```

Each file is small (~30–60 lines): hermetic env → `runCli` → assert exit code + structured output. The `install-skills.test.ts` is the longest; it asserts both stdout and post-state filesystem.

**Acceptance:**
- All seven test files pass.
- Each test calls `runCli` against the **bun-compiled** binary at `$(which exarchos)` — not against the JS bundle. Preflight enforces this.
- No test imports from `src/` or `servers/exarchos-mcp/src/`. Production wiring or nothing.

**Effort:** ~4 days.

## 6. Schedule and GA cut line

| PR | Effort | Depends on | Cut line |
|----|--------|-----------|----------|
| P1 | 1 week | (current main) | v2.9.0 GA |
| P2 | 1 week | P1 | v2.9.0 GA |
| P3 | 1 week | P1 (recommend after P2 + P4 land) | v2.9.0 GA |
| P4 | 4 days | P1 | v2.9.0 GA |
| **GA total** | **~3.5 weeks** | | **v2.9.0 GA** |
| P5 | 1 day + matrix cost | P4 (Windows needs the CLI tests to be portable) | v2.10 |
| P6 | 2 days | P3 (so conformance + parity don't collide on normalizer) | v2.10 |

Schedule risk noted in §3 of the parent ideate transcript: 3.5 weeks of focused harness work in front of a release already at rc.3 is non-trivial. Mitigations:

- P1, P2, P4 can be developed in parallel after P1's first commit lands (the foundation files don't conflict with P2/P4 test files).
- P3 leans on the normalizer; sequencing it last lets P2/P4 land any normalizer extensions they need first.
- An rc.4 can ship at any point during P1+P2+P4 with the harness behind a `npm run test:process` script that is **not** wired to the PR gate yet — the gate flips on once P3 lands.

## 7. Cross-cutting #1109 invariant coverage

| #1109 invariant | Covered by | How proven |
|-----------------|-----------|------------|
| #1 Event-sourcing integrity | P3 reconstructability test (F6.1) | `replayInto(snapshotEventStream(...))` produces equal projections |
| #2 MCP parity | P3 per-action parity tests | `assertParity(cliResult, mcpResult, spec)` for `view.describe` / `event_log` / `rehydrate` |
| #3 Basileus-forward | P1 fixture design (no local-only assumptions) + P4 mcp-start-stop test | `spawnMcpClient` uses `StdioClientTransport`; no assumption MCP is local-process-only at the fixture layer |
| #4 Capability resolution | Out of scope this design (deferred per #1139 to capability-resolver follow-up) | n/a — explicit defer |

## 8. Axiom dimension mapping

| PR | DIM-1 | DIM-3 | DIM-4 | DIM-7 | Other |
|----|-------|-------|-------|-------|-------|
| P1 | Process boundary visible at call site | Fixture API stable | Real binary, real stdio | `expectNoLeakedProcesses` | DIM-5 (no optional facades), DIM-6 (single-responsibility helpers) |
| P2 | HSM topology under saga test | Skill-doc-as-contract validated | Saga over real binary | Subprocess termination | F6.1 reconstructability primitive built |
| P3 | Event store as composition root made testable | Per-action parity contract | CLI ↔ MCP equivalence | (n/a) | Closes #1109 invariants #1 + #2 |
| P4 | (n/a) | Subcommand surface enumerated | Bun-compiled binary, real `$HOME` | Process start/stop, SIGTERM handling | Cross-platform regression detector |

## 9. Risks and mitigations

Carries forward all five risks from the original design §9 (npm link non-determinism, spawn latency, tmp-dir cleanup races, flaky termination, fixture sprawl). Adds:

| Risk | Mitigation |
|------|-----------|
| #1166's coderabbit comments include design-level concerns that block rebase | Pre-rebase: triage all 15 comments by category (style / structural / design). Address structural inline; defer style to a follow-up commit on the same PR. |
| Saga harness becomes a generic "test DSL" and grows beyond charter | Same charter rule as fixture library: if a helper is consumed by only one test file, it lives in that test file. `saga-driver.ts` ships only `driveSaga(client, calls)` — nothing more. |
| Parity contract spec drifts from MCP/CLI implementation | `parity-contract.ts` lives in `test/fixtures/`. Any new action exposed on both surfaces requires an entry. CI guard (~10 lines) compares the action set in `parity-contract.ts` against the action set returned by `tools/list` against `schema` introspection; mismatch fails the build. (Defer guard to v2.10 if it adds friction; see open question 10.4.) |
| Event-replay primitive depends on MCP server exposing `event_log` view | Verified present: `servers/exarchos-mcp/src/orchestrate/` includes view handlers post-rehydrate-foundation (`f9078813`). If the action shape changes, P3 tests break loudly. |
| 3.5-week harness work delays v2.9.0 GA past rc.4 | Decoupled merge cadence (§6): P1+P2+P4 can land behind a non-gating script; only P3 wires the PR gate. v2.9.0 GA can ship with `test:process` available locally and in nightly only, with PR-gate activation as a follow-up commit. |

## 10. Open questions (deferred to plan or follow-up ideates)

**10.1 P1 rebase scope:** does the rebase preserve PR #1166's commit history (interactive rebase + force-push) or open a new PR with a single squashed commit citing #1166? Plan-phase decision; affects review continuity vs. clean history.

**10.2 P2 saga driver shape:** does `driveSaga` capture per-step events and expose them, or only the final state? §5.2 sketches the latter; #1206 may need the former. Defer to plan.

**10.3 P3 parity tolerance for HATEOAS `_links`:** the envelope's `_links` array is order-dependent today. Should the parity contract treat it as a set, an array, or a per-action choice? Defer to plan; default to per-action choice.

**10.4 Action-surface CI guard (risk row above):** ship in P3 or v2.10? If it's >50 lines, defer.

**10.5 P5/P6 sequencing in v2.10:** does P5 (Windows matrix) gate on P6 (conformance) so we don't double-publish a flake budget, or does P6 ship first because conformance is a one-shot integration?

## 11. References

**Internal:**
- `docs/designs/2026-04-19-process-fidelity-harness.md` — original design (carry-forward §s 4.1, 4.3, 4.5, 4.6, 5)
- `docs/research/2026-04-19-e2e-testing-strategy.md` — strategy doc (Tier 1 framing; F6.1 is a named extension to §6 F6)
- `docs/plans/2026-04-19-process-fidelity-harness.md` — original plan (P1 mostly carries forward)
- `CLAUDE.md` — architecture overview
- axiom dimensions: `~/.claude/plugins/cache/lvlup-sw/axiom/0.2.7/skills/backend-quality/references/dimensions.md`

**External:** (unchanged from original §11)
- `@modelcontextprotocol/sdk` `StdioClientTransport`
- `@modelcontextprotocol/conformance` (P6 only)
- `@scalvert/bin-tester` (reference pattern for P4)

**Related issues:**
- PR #1166 (open) — P1 rebase target
- #1167 — supersede with P2 (different scope but adjacent surface; close as "superseded by P2 in 2026-05-05 design")
- #1168 — supersede with P4 (broader scope; close as "superseded")
- #1170 — defer to v2.10 P5
- #1109 — operationally proven by P3
- #1208, #1206, #1205, #1209 — regression-test coverage in P2
- #1180, #1179 — reconstructability coverage in P3
- #1118 — partially addressed by P5 in v2.10
- #1139 — capability-resolver tests remain deferred (out of scope this design)
