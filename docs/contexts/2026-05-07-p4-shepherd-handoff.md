# P4 Shepherd Handoff — #1229

**Date:** 2026-05-07
**Workflow:** `e2e-v29-revisited`
**Status:** v2.9.0 GA already shipped (P1/P2/P3 merged). #1229 (P4) remains.

## What you're picking up

- **PR #1229** — `test(e2e): P4 CLI surface — 7 process-fidelity tests`
- **Branch:** `feature/e2e-v29-p4-cli-surface` → `main`
- **Review state:** `CHANGES_REQUESTED`
- **Mergeable:** unknown (likely `CONFLICTING` after P1/P2/P3 squash-merged into main)

P4 was originally based off `feature/e2e-v29-p1-foundation` and was auto-retargeted to `main` when P1 merged. It has not been rebased since P2 and P3 also landed.

## v2.9 GA stack — already merged

| PR | Squash SHA |
|---|---|
| #1215 P1 foundation | `164242d5` |
| #1223 P2 saga + #1208 fix | `fc4c4d79` |
| #1231 P3 parity + F6.1 (GA gate) | `17a4226b` |

## Critical learnings from P1–P3 shepherd cycles that likely apply to P4

### 1. `WORKFLOW_STATE_DIR` is the load-bearing env var

`servers/exarchos-mcp/src/utils/paths.ts:54` — `resolveStateDir()` only reads `WORKFLOW_STATE_DIR`. The fixtures historically set `EXARCHOS_STATE_DIR` (a name nothing reads), so every "hermetic" test was sharing the host's default state dir. Fixed in P3 (`b848ca0c`) — `hermetic.ts` and `mcp-client.ts` now set both.

**Action for P4:** verify that any P4 test invoking `runCli` passes `WORKFLOW_STATE_DIR` explicitly (the parity tests in P3 had to do this — `EXARCHOS_STATE_DIR` alone was ignored). The P4 tests cover `install-skills`, `doctor`, `version`, `schema`, `topology`, `emissions`, `mcp` start-and-shutdown — most of these read state, so isolation is load-bearing.

### 2. `task.assigned` events require `title`

The schema requires `title` in `data`. Saga drivers don't unwrap tool-level `success: false` envelopes — append failures slide through silently when state was being shared. P4 tests that emit task events should include `title`.

### 3. Rebase pattern after the upstream squash-merges

When the PR base has accumulated multiple squashed PRs and `gh pr update-branch --rebase` fails:

```bash
git rebase --onto origin/main <last-shared-commit>
```

For P4, the last commit P4 shares with the now-squashed P1/P2/P3 chain needs to be identified. P4 was branched off P1, so the last shared commit is likely the tip of the original P1 foundation (`62232069 fix(p1): unblock #1215`).

### 4. Stale CodeRabbit/sentry threads

CodeRabbit and sentry threads do not auto-resolve when fixes land. Many "unresolved" findings in P1/P2/P3 had been addressed in earlier commits — the assess_stack output shows them as actionable but they're stale. Always cross-reference commit SHAs cited in thread bodies before re-fixing.

### 5. CI binary vs source drift

Process tests pin to `dist/bin/exarchos-linux-x64`. After source changes, run `npm run build:binary -- --linux-x64` before `npm run test:process` or the test runs against stale code.

## Cross-cutting concerns to apply (#1109)

- **Constraint 1 (event-sourcing integrity):** every new test surface must verify the events it emits match what the projection reads.
- **Constraint 2 (MCP parity):** any CLI envelope must match the MCP envelope shape under `assertParity` per the contract.
- **Constraint 3 (Basileus-forward):** no test should assume MCP is local-process-only.

## Axiom dimensions to apply

- **D2** (typing): prefer Zod schemas / discriminated unions over `Record<string, unknown>` casts at envelope boundaries.
- **D4** (operational resilience): no silent failures, no whitespace-passes-empty-check predicates.
- **D5** (workflow determinism): tests must fail closed on contract regressions, not silently treat them as empty.

## Suggested first steps

1. `git checkout feature/e2e-v29-p4-cli-surface && git fetch origin main`
2. Identify last shared commit with P1: `git log --oneline origin/main..HEAD | tail -10` — find the boundary between P1 commits (already in main) and P4-specific commits.
3. `git rebase --onto origin/main <boundary>` to drop duplicated P1 commits.
4. Run `npm run typecheck && npm run test:run && npm run build:binary -- --linux-x64 && npm run test:process` — likely surfaces same `WORKFLOW_STATE_DIR` / `title` issues that P3 had.
5. Run `assess_stack` for #1229 to see open coderabbit/sentry findings.
6. Force-push, post shepherd comment, iterate.

## Files likely needing the same fixes as P3

If P4 added new process-fidelity tests, check each test for:

- `runCli({ env: { EXARCHOS_STATE_DIR: ... } })` — needs `WORKFLOW_STATE_DIR` added
- `task.assigned` events without `title`
- `SpawnedMcpClient` casts where `SagaToolClient` would suffice
- `step.error !== undefined` checks where `s.kind === 'error'` is the new pattern (after the discriminated-union refactor in P2)

## Filed but not yet acted on

- **#1238** — `refactor(mcp): replace Record casts with Zod discriminated unions in next-actions-from-result` (v3.0.0 backlog) — deferred Zod hardening from P2 review.

## Backlog issues filed during this workflow

#1232–#1237 — six v2.10+ deferral items (macOS runner, F4 probes, F5 fixtures, full F6 saga, mcpjam, F6 multi-agent), all parented to `v3.0.0`.
