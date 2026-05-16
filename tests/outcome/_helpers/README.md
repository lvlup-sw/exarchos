# tests/outcome/_helpers

Operator-facing guide to the helpers that back the outcome-test tier. Read this
before adding a new outcome test or fixing a `it.fails()` test that just
flipped to passing.

## Purpose

The outcome tier exists to verify **operator-visible reality**: that running
the real CLI binary, against a real filesystem, with a real `git` on `PATH`,
produces the state and exit codes an operator would observe. This is distinct
from the other two tiers:

- **Unit tests** (`npm run test:run`) check algorithm equivalence with mocked
  collaborators. They prove a function does what the function intends.
- **Process / integration tests** (also under `test:run`) wire several
  components together with light fakes and assert on their composed shapes.
- **Outcome tests** (`npm run test:outcome`) drive `execFileSync('node',
  ['dist/bin/cli.js', ...])` or the real `git` binary against a real tmpdir
  and assert on what the operator sees: files on disk, exit codes, stderr
  prose, and git state. No mocking of process, fs, or child_process.

To keep these tests hermetic the helpers in this directory build each test's
workspace from `fs.mkdtempSync` plus real `git init`, so every test owns its
HOME / repo / worktrees and there is no cross-test contamination. The outcome
tier is **Linux-only** (the dedicated CI job pins `runs-on: ubuntu-latest`)
and is run **serially** — file-level parallelism would race on mkdtemp
collisions, port allocation, and shared `git` lock files inside the same
worktree.

## `withTmpHome`

`tmp-home.ts` exports a single helper:

```ts
async function withTmpHome<T>(fn: (home: string) => Promise<T>): Promise<T>
```

### Contract

- Creates a fresh tmpdir under `os.tmpdir()` (`exarchos-outcome-*`).
- Sets `process.env.HOME` to that tmpdir for the duration of `fn`.
- On callback return *or throw*, restores the prior `HOME` value — or
  `delete process.env.HOME` if HOME was unset on entry.
- Removes the tmpdir (recursive, force) in the `finally` block. Cleanup runs
  even if `fn` throws.
- Returns whatever `fn` returns.

### When to use it

Reach for `withTmpHome` whenever your test invokes a command that writes
beneath `$HOME`. The most common case is the CLI's `install-skills` action,
which lays down per-runtime config under `$HOME/.claude/`. Any command that
touches `$HOME/.config/`, `$HOME/.local/`, or per-runtime plugin caches needs
the same isolation.

### Example

```ts
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { withTmpHome } from './_helpers/tmp-home.js';

describe('cli --help', () => {
  it('prints usage without writing to HOME', async () => {
    await withTmpHome(async (home) => {
      const out = execFileSync(
        'node',
        [path.resolve('dist/bin/cli.js'), '--help'],
        { env: { ...process.env, HOME: home }, encoding: 'utf8' },
      );
      expect(out).toMatch(/Usage:/);
    });
  });
});
```

Note: pass HOME explicitly in `env`. `execFileSync` does not inherit the
mutated `process.env` on every platform/runtime combination, so threading it
through the call is the safe pattern.

## `withTmpGit` and `addSiblingWorktree`

`tmp-git.ts` exports two helpers for tests that exercise real `git`:

```ts
async function withTmpGit<T>(fn: (repoPath: string) => Promise<T>): Promise<T>
async function addSiblingWorktree(
  repoPath: string,
  branchName: string,
): Promise<string>
```

### `withTmpGit` contract

- Creates a fresh tmpdir (`exarchos-outcome-git-*`).
- Runs `git init -b main` inside it.
- Sets `user.email=test@example.com` and `user.name=test` locally.
- Creates an empty initial commit on `main` so the repo has a valid HEAD.
- Invokes `fn(repoPath)`.
- Cleanup: removes every sibling worktree registered via
  `addSiblingWorktree` (using `git worktree remove --force`, then `fs.rmSync`
  as a belt-and-braces fallback), then removes the primary tmpdir.

### `addSiblingWorktree` contract

- Creates a new sibling worktree on `branchName`, located at
  `${repoPath}-wt-${branchName}` (outside the primary worktree's `.git/`).
- Registers the new sibling so `withTmpGit`'s cleanup tears it down.
- Returns the sibling's absolute path.

### When to use them

Use `withTmpGit` whenever your test invokes real git operations: merge
preflight checks, ancestry lookups, `git worktree` enumeration, or any
handler that reads `git rev-parse` / `git symbolic-ref` to inspect the real
working tree. Use `addSiblingWorktree` on top when the bug under test only
reproduces in a multi-worktree topology — for example, merge-orchestrator
preflight that needs to detect a branch already checked out elsewhere.

### Multi-worktree example

```ts
import { describe, it, expect } from 'vitest';
import { withTmpGit, addSiblingWorktree } from './_helpers/tmp-git.js';
import { execSync } from 'node:child_process';

describe('merge preflight in multi-worktree topology', () => {
  it.fails('detects target branch checked out in a sibling', async () => {
    await withTmpGit(async (repo) => {
      const releaseWt = await addSiblingWorktree(repo, 'release');
      const integrationWt = await addSiblingWorktree(repo, 'integration');

      // Drive the real handler against the primary worktree. It must see
      // that `release` is occupied by `releaseWt` and refuse the merge.
      const result = execSync(
        `node dist/bin/cli.js merge --from integration --into release`,
        { cwd: repo, encoding: 'utf8' },
      );

      expect(result).toMatch(/release.*checked out at.*\/-wt-release/);
      expect(releaseWt).toMatch(/-wt-release$/);
      expect(integrationWt).toMatch(/-wt-integration$/);
    });
  });
});
```

## `it.fails()` choreography

This section is operationally critical. Read it before adding or flipping
any outcome test.

### Why `it.fails()`

The outcome tier encodes known regressions as RED tests *before* the fixes
land. Wrapping each test in `it.fails()` lets the test sit in `main`
continuously while the bug exists, without breaking CI. The test documents
the operator-visible spec the eventual fix must satisfy; the annotation
keeps it from breaking the branch in the meantime.

### The atomic-flip contract

A fix PR must remove the `.fails` annotation in the same diff that
introduces the fix. Reviewers verify operator-visible correctness simply by
grepping for the annotation removal — there is no need to read the test
body to understand which spec the fix satisfies. The shape is:

```diff
-  it.fails('refuses to overwrite an existing bundle', async () => {
+  it('refuses to overwrite an existing bundle', async () => {
```

If your fix PR touches source code without flipping an outcome test, you are
either fixing something the outcome tier did not cover (consider adding a
test) or claiming a fix without operator evidence (push back in review).

### What failure mode is acceptable

vitest's `it.fails()` expects the test to throw or fail an assertion.
An **expected failure** does *not* count as a CI failure. A test that
**unexpectedly passes** without the annotation being flipped *does* break
CI — that is the enforcement mechanism for the choreography. You cannot
land a silent fix; the test will go green and CI will refuse to merge until
you flip the annotation.

### How to read the failure summary

A healthy steady-state summary looks like:

```text
 Tests  8 expected | 0 failed | 0 passed (8)
```

Interpret the columns as follows:

- `expected` — `it.fails()` tests that failed as designed. This is the
  number of bugs the tier currently encodes. Trending toward zero is good.
- `failed` — unexpected failures: either a plain `it()` test broke, or an
  `it.fails()` test unexpectedly passed. Treat these as CI red. Investigate.
- `passed` — plain `it()` tests that passed. These are the helpers'
  self-tests and any non-regression coverage.

If `failed` is nonzero, do not flip annotations to silence it. Read the
failing test, decide whether the fix is in your diff (then flip), or
whether you have introduced a new regression (then revert / fix forward).

## CI gating

The outcome tier runs in the dedicated `outcome-tests` job in
`.github/workflows/ci.yml`. It is Linux-only (`runs-on: ubuntu-latest`) and
invokes `npm run test:outcome`. The job is intended to be wired as a
required branch-protection check; that wiring is a manual repository-settings
step (Settings → Branches → main → required status checks) and may not yet
be enforced. Once enabled, the PR body for the change should record it.
Until then, the gate is enforced by `ci-gate`'s `needs: [...outcome-tests]`
dependency, which makes the aggregate CI Gate check fail when outcome-tests
fail.

The outcome tier is intentionally excluded from `npm run test:run`. That
surface stays scoped to unit + process tiers so day-to-day local iteration
stays under a few seconds. To run all three tiers locally:

```bash
npm run test:run && npm run test:outcome
```

### Failure modes

- **Real failures** — a plain `it()` test fails, or an `it.fails()` test
  unexpectedly passes. CI goes red. Investigate; do not silence with an
  annotation flip unless your diff is the fix.
- **Expected failures** — `it.fails()` tests fail as designed. CI stays
  green. This is the normal steady state until the next fix PR lands and
  flips one of them.

## Canonical first occupants

The Wave 1 substrate seeded the tier with three outcome tests; cite them as
examples when authoring new ones:

- `tests/outcome/install-skills.test.ts` — encodes issue #1355
  (`install-skills` bundling behavior).
- `tests/outcome/merge-orchestrate-multiworktree.test.ts` — encodes issue
  #1356 (merge-orchestrator preflight under multi-worktree topology).
- `tests/outcome/rehydrate-projection-drift.test.ts` — encodes issue #1359
  (rehydrate projection drift; remains `it.fails()` until Wave 2 lands
  the fix).

Each was authored as `it.fails()` against the helpers documented above.
When you land the fix for one, flip the annotation in the same PR as the
source change.

## Coverage matrix

The table below maps each dogfood-finding regression that ships an
outcome-tier test to its carrier file. Entries marked `n/a` indicate a
regression whose reproduction is outside the Linux outcome tier's scope
(typically Windows-specific behavior). Process-tier carriers are linked
where the outcome assertion lives in `test/process/` instead of
`tests/outcome/` — usually because the regression requires multi-step
saga choreography rather than a single CLI/handler invocation.

| Dogfood Finding | Outcome Test | Status |
|---|---|---|
| #1355 install-skills | [`install-skills.test.ts`](../install-skills.test.ts) | OK |
| #1356 merge multi-worktree | [`merge-orchestrate-multiworktree.test.ts`](../merge-orchestrate-multiworktree.test.ts) | OK |
| #1359 projection drift | [`rehydrate-projection-drift.test.ts`](../rehydrate-projection-drift.test.ts) | OK |
| #1360 reserved-fields | [`reserved-fields-discoverability.test.ts`](../reserved-fields-discoverability.test.ts) | OK |
| #1363 runbook | [`runbook-merge-orchestration.test.ts`](../runbook-merge-orchestration.test.ts) | OK |
| #1364 telemetry split | [`telemetry-action-errors.test.ts`](../telemetry-action-errors.test.ts) | OK |
| #1362 Windows preflight | [`preflight-debug.test.ts`](../preflight-debug.test.ts) (instrumentation only) | OK |
| #1374 saga detour wire | [`test/process/saga-merge-detour.test.ts`](../../../test/process/saga-merge-detour.test.ts) (process tier) | OK |

Notes:

- #1362 has two distinct concerns. The Linux outcome tier covers the
  **instrumentation contract** for the Phase-1 debug payload —
  `preflight-debug.test.ts` asserts that `EXARCHOS_PREFLIGHT_DEBUG=1` attaches
  the structured debug block to `merge.preflight` events when ancestry fails,
  and that the gate is no-op when the env var is unset or ancestry passes.
  The Linux outcome tier is **out of scope for reproducing the Windows-
  specific bug itself** (the ancestry false-positive only manifests under
  Windows path semantics and process-launch behavior); reproduction belongs
  in a future Windows-CI surface (cf. the "No Windows CI for MCP server"
  tracking line in the v2.x roadmap). Phase-2 root-cause analysis awaits one
  Windows-host event with the new payload.
- #1374 is a saga-shape regression. Its assertion lives in the process
  tier (`test/process/saga-merge-detour.test.ts`) because reproducing it
  requires orchestrating a multi-step delegation + merge-detour saga
  rather than a single handler call — the process tier is the right
  granularity for that shape, and the outcome tier is reserved for
  single operator-visible CLI / handler invocations.
