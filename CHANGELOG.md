# Changelog

All notable changes to Exarchos are documented in this file. Organized by semver release.

## [Unreleased]

### Operator notes

- **`prepare` takes the repository from its caller and pins the scope in the capsule.** This is a change of behavior. The compiler is now `exarchos-prepare-4`.
  - `prepare` requires `repoRoot`, an absolute path. A call with no `repoRoot`, or with a relative path, is refused, and nothing is recorded: dispatch refuses it at the parse of the action schema, and the handler refuses a direct call with `INVALID_INPUT`. `prepare` reads nothing from the directory of the server.
  - The `repoRoot` of `prepare` is the tree that holds `baseRef`: the worktree where the integration branch (`synthesis.integrationBranch`) is checked out. `prepare` reads the repository, the config and the invariant catalogs from that checkout.
  - The capsule pins `settlementContract.scope`: the git common dir (`repository`), the root of the work tree that `prepare` read (`checkout`), and the digest of `.exarchos.yml` and `.exarchos.yaml` at the checkout (`configDigest`). Each task gets `baseCommit`, the commit of `baseRef` in the checkout.
  - The scope, the base commit and the design source are compile inputs. Another checkout, a moved base, an edit of a config file (also for a tier outside the batch) or an edit of a readable design record compiles the next capsule version. The design source digests the bytes of the design record when its reference stays under the checkout. Else it digests the reference.
  - The capsule text names only the gates that the task-completion runbook runs, less the gates that the config of the checkout disables. It no longer names `check_integration_suite`.
  - The new refusal `SCOPE_UNRESOLVED` has five causes: `repoRoot` is not inside a git work tree, the latest capsule of the workflow pins another repository, the config of the checkout does not load, a registered invariant catalog does not resolve, or the config does not make `check_static_analysis` blocking. A task completes only on a passing static-analysis record, so `prepare` refuses a disabled or warning-only static analysis before fan-out.
  - `BASE_UNRESOLVED` has three more causes: a tag has the name of `baseRef`, the repository of the checkout holds no commit of `baseRef`, or the base commit does not hold the landed commit of a completed blocker of a batch task. Git resolves a name that is both a branch and a tag to the tag, so `prepare` refuses such a tag before it resolves the base. The landed commit is the `mergeSha` of the latest `merge.executed` row of the blocker on `baseRef`, else the `commit` of its completion row. A blocker with no known commit is not checked.
  - Land a task by a fast-forward or a merge that keeps its commit, or through `serialize_merge`, which records the `merge.executed` row. A squash or a rebase outside `serialize_merge` leaves the dependent task refused until a `merge.executed` row records the landing.
  - Recovery: when `prepare` refuses `SCOPE_UNRESOLVED` because `repoRoot` is not inside a git work tree, pass as `repoRoot` the worktree where the integration branch is checked out, then prepare again.
  - Recovery: when `prepare` refuses `SCOPE_UNRESOLVED` for another repository than the latest capsule, run `prepare` with a `repoRoot` in a checkout of the pinned repository. A repository that moved, or a new clone, cannot continue the workflow: put the clone back at the pinned path, or start a new workflow for the rest of the work.
  - Recovery: when `prepare` refuses `SCOPE_UNRESOLVED` for a config or a catalog of the checkout, repair or remove the file that the message names, or remove the registration of the catalog. Then prepare again.
  - Recovery: when `prepare` refuses `SCOPE_UNRESOLVED` because the config makes `check_static_analysis` disabled or warning-only, make it blocking in `review.gates` or `review.dimensions.D2` of the `.exarchos.yml` of the checkout. Then prepare again.
  - Recovery: when `prepare` refuses `BASE_UNRESOLVED` because a tag has the name of `baseRef`, delete or rename the tag, then prepare again.
  - Recovery: when `prepare` refuses `BASE_UNRESOLVED` for a completed blocker, land the blocker on `baseRef`, then prepare again. When the blocker landed by a squash or a rebase outside `serialize_merge`, record that landing with a `merge.executed` row whose `taskId` is the blocker, whose `targetBranch` is `baseRef` and whose `mergeSha` is the landed commit.
  - Limit: `prepare` does not check that the checkout holds `baseRef`. The config of record is the working tree of the checkout, whatever branch it holds.

- **`prepare_delegation` reads the repository of its caller.** It takes an optional `repoRoot`. A relative `repoRoot` is refused with `INVALID_INPUT` before any git call, and the call records nothing.
  - The branch read, the protected-branch check, the ancestry preflight and the stash probe run in `repoRoot`. A relative `planPath` resolves against `repoRoot`. Without `repoRoot`, the call keeps the directory of the server, as before, and returns a warning.
  - The `repoRoot` field of `exarchos_orchestrate` in `tools/list` has no absolute pattern, because one field serves every action and a gate call passes `repoRoot: 'auto'`. The absolute rule of `prepare` acts at the parse of dispatch and in the handler. The rule of `prepare_delegation` acts only in the handler.
  - Limit: the main-worktree guard of `prepare_delegation` still reads the directory of the server, not `repoRoot` ([#1928](https://github.com/lvlup-sw/exarchos/issues/1928)).

- **`settle` checks each claimed worktree against the pinned scope before any gate runs.** This is a change of behavior. When the capsule pins a scope, `settle` observes with git the worktree of each completed claim that names a `worktreePath`, once for each call.
  - Nine rules run in order. A claimed worktree is in scope when git answers, it is the root of a work tree of the pinned repository, it is not the checkout and not the primary worktree of the repository, and it is not on `baseRef`. Its branch matches a branch that the claim names, its HEAD holds `baseCommit`, `git status --porcelain` is empty, and no other claim of the batch and no completion row of another task names it.
  - The first rule that fails gives the finding `worktree-out-of-scope`, of the unresolved class. Its message names the cause: `unobservable`, `not-a-worktree-root`, `other-repository`, `the-checkout`, `on-the-base-branch`, `other-branch`, `base-not-held`, `uncommitted-changes` or `shared-worktree`. That task runs no gate, the other tasks of the batch still verify, and the batch is `corrective-capsule`.
  - One linked worktree for each task. `settle` and `task_complete` refuse the checkout that `prepare` read and the primary worktree of the repository (`the-checkout`), because each task of a prepared workflow runs in its own linked worktree. The primary worktree is the parent of the common dir when that directory is named `.git`.
  - A claimed worktree must be clean. The ignore rules of git apply, and so does the exclude file of the common dir. The pattern `node_modules/` does not match a symbolic link, so a linked `node_modules` needs the ignore rule `node_modules`.
  - The worker starts from `baseCommit`. The agent definitions of the implementer and the scaffolder now run `git switch -c <own branch> <baseCommit>` before any file change, then check that HEAD holds `baseCommit`. The agent files of the five runtimes are regenerated.
  - A fix continues the earlier branch of its task. The fixer works in the earlier worktree, or, under native isolation, the coordinator removes the earlier worktree and the fixer switches its own worktree to the earlier branch. It rebases that branch onto `baseCommit` when HEAD does not hold it, and its claim names the same `branch`.
  - Ownership is by exclusion. No branch is pinned for each task.
  - The bundle trace of a verified task carries `treeCommit`, the head of its static-analysis row. The receipt does not carry it.
  - Recovery: when a claim gets `worktree-out-of-scope`, do what its message says. Fork a worktree of its own from `baseRef` at `baseCommit` and do the work of the task there, or make the worktree readable to git. Then claim the task in a new batch.
  - Recovery: when the cause is `uncommitted-changes`, commit the listed files of the task in its worktree. Remove a listed file that a gate run left, and commit none of them. Then claim the task in a new batch.
  - Recovery: when a linked `node_modules` gives `uncommitted-changes`, add `node_modules`, without a trailing slash, to `.gitignore` or to the exclude file of the common dir.
  - Recovery: when a fix on a new branch halts at the completion leaf after a static-analysis failure, run `check_static_analysis` with `taskId`, the earlier branch as `branch`, `repoRoot: 'auto'` and the `worktreePath` of the new tree. Then settle the claim under a new batch id.
  - Limit: a claim on a linked worktree that no task made, on another branch than `baseRef` or detached, that holds `baseCommit` passes the rules. So does a claim on the worktree of a sibling whose claim carries no fields, and a completion on the worktree of a sibling whose claim is still in flight ([#1928](https://github.com/lvlup-sw/exarchos/issues/1928)).
  - Limit: a repository whose common dir is not named `.git` has no primary worktree by this rule, so the rule refuses only the checkout there.

- **`task_complete` accepts only a pass on the tree and the commit that the completion names.** This is a change of behavior. It closes the wrong-tree half of the completion defect of [#1886](https://github.com/lvlup-sw/exarchos/issues/1886) on a stream whose capsule pins a scope.
  - The runner row of each producer gate names the tree that it scanned and its head (`details.worktree`, `details.head`). `task_complete` observes the tree of `result.worktreePath`, and the latest passing runner row must name the same tree and the same head. Else it refuses with `GATE_NOT_PASSED` and the cause `other-tree`.
  - A runner row of an earlier build names no tree, so it does not complete a named tree.
  - On a stream with a prepared record, a completion that names no tree is refused with `tree-unnamed`. An empty `result.worktreePath` names no tree. On a stream with no prepared record, such a completion goes ahead as before ([#1927](https://github.com/lvlup-sw/exarchos/issues/1927)).
  - With a scoped capsule, `task_complete` refuses a named tree that is the checkout or the primary worktree, or that is on the base branch. It also refuses a tree on another branch than `result.branch`, outside the pinned repository, or without `baseCommit`. It refuses a tree that the completion row of another task names. The cause is `tree-out-of-scope`, and the message names the rule.
  - A reference capsule with no scope, or one that custody cannot return, judges only the same-tree rule.
  - `check_static_analysis` with `taskId` needs `repoRoot`. A run with `taskId` and no `repoRoot` no longer scans the directory of the server: it records a `repo-root-missing` skip, and `task_complete` refuses on it.
  - The completion row carries the canonical `worktreePath` and the observed head as `commit`.
  - A retry of `task_complete` for a completed task that no `task.failed` row reopened checks the gate, then returns the stored row. It does not judge the tree again, so a retry after a landing or a prune of the worktree is not refused with `other-tree`.
  - The new causes of `GATE_NOT_PASSED` are `other-tree`, `tree-unnamed`, `tree-out-of-scope`, `repo-root-missing` and `disabled-by-config`. Each refusal names its recovery.
  - Recovery: when `task_complete` refuses with `other-tree`, `tree-unnamed` or `repo-root-missing`, run `check_static_analysis` with `taskId`, `repoRoot: 'auto'` and the `worktreePath` of the worktree of the task. Then name that worktree in `result.worktreePath`, and call `task_complete` again.
  - Recovery: when `task_complete` refuses with `tree-out-of-scope`, fork a worktree of the pinned repository from `baseRef` at `baseCommit`, on a branch of its own, and do the work of the task there. Record a pass there, and name it in `result.worktreePath`. A call with no `capsuleVersion` also passes the version of the batch of the task.

- **Every gate action resolves its config severity through one wrapper, and a disabled gate still records its rows.** This is a change of behavior. It closes defect 1 of [#1886](https://github.com/lvlup-sw/exarchos/issues/1886): disabled and warning gates are now honoured.
  - `withGateSeverity` wraps each of the 28 gate actions of the registry. `withConfigSeverity` and `applyLadderGateSeverity` are deleted.
  - A disabled gate does not run its provider. The gate runner records the skip `disabled-by-config`, and it still appends each declared `gate.executed` row. A warning gate runs, and a failing verdict passes with a warning. Its record keeps the failing verdict. An error is never softened.
  - A skip is never softened, also in the audit mode of the implement phase (`oneshot`). A skip with `passed: false`, such as the `no-toolchain` skip of `check_static_analysis`, keeps `passed: false` and gets no warning. The deleted `applyLadderGateSeverity` softened such a skip in audit mode. A failing verdict of a gate that ran still passes with a warning in audit mode.
  - A register in `src/verbs/gates/gate-severity.ts` marks each gate action where a severity has a reduced meaning, with a reason and an owner. A disabled `mutation-adequacy` acts as `warning`. `check_review_verdict` and `check_invariant_conformance` take no severity ([#1976](https://github.com/lvlup-sw/exarchos/issues/1976)), and neither do `prepare_synthesis`, `prepare_review` and `discover_bridge`. `check_mock_boundary` keeps a second, advisory resolution.
  - `task_complete` refuses a `disabled-by-config` skip of static analysis with a cause of its own.
  - Contract drift and mock boundary measure from the base of the capsule (`baseRef`) in the segment, not from `main`. A contract-drift run with no base gives `base-missing`, which blocks. A mock-boundary run with no base gives an advisory `base-missing` finding. A direct call names the base in `baseBranch`.
  - At review, `check_invariant_conformance` gives a HIGH finding for a registered catalog that does not resolve and for a config that does not load, so its verdict is not APPROVED. With no `repoRoot`, it loads the config and the catalogs from the checkout of the latest capsule of the workflow, else from `process.cwd()`.
  - Recovery: when `task_complete` refuses a `disabled-by-config` skip, enable `check_static_analysis` in the `.exarchos.yml` of the checkout and keep the D2 dimension enabled and blocking. Then run the gate again.

- **`settle` runs the segments under the config of the checkout, and a capsule of an earlier compiler settles only after a new prepare.** This is a change of behavior, and the upgrade is one way.
  - When a batch needs a segment, `settle` computes the digest of the config files at `scope.checkout` once for each call. A digest that differs from `scope.configDigest` refuses the call with `CAPSULE_UNRESOLVED`, and no gate runs. A digest that matches runs the segments under the config of the checkout, so a gate that this config disables is skipped.
  - A capsule of compiler `exarchos-prepare-3` pins no scope. It still decodes, but a batch on it that needs a segment is refused with `CAPSULE_UNRESOLVED`, and so is a task with no `baseCommit`. The check runs only when a segment is needed, so a held batch of such a capsule can still be decided by rejecting.
  - The stored shapes change one way and additively, and `SCHEMA_VERSION` stays 6. An earlier build cannot read a settlement bundle with the finding kind `worktree-out-of-scope` or a capsule of compiler `exarchos-prepare-4`, so keep one build for each store.
  - Recovery: when `settle` refuses `CAPSULE_UNRESOLVED` because the config of the checkout changed after `prepare`, prepare again with the same `repoRoot`, then claim the tasks in a new batch under the new capsule version.
  - Recovery: on a decision round under a changed config, put the config files of the checkout back to the bytes that `prepare` read, then send the same decision again. Or decide by rejecting, then prepare again and propose the deviation again in a new batch under the next capsule.
  - Recovery: decide each held batch before you upgrade. After the upgrade, a held batch on an `exarchos-prepare-3` capsule can still be decided by rejecting. For each other batch on such a capsule, prepare again under this build, then claim its tasks in a new batch.
  - Limit: the config digest and the loaded config come from two reads of the files. An edit between the two reads runs under bytes that the digest does not cover.

- **`task_complete` accepts only the static-analysis verdict that the gate runner recorded for that task.** This is a change of behavior. The handler reads the latest `gate.executed` row that the gate runner wrote for the task at `details.taskId`, under the runner key `gate.executed:<evidenceId>`. That row must pass. The evidence record that the row cites must be an active passing static-analysis record for the same task. A record is not active when a later record supersedes it. Any other active record of the task that does not pass refuses the completion. A later failing run thus wins over an earlier pass, also when the runner did not write the row of the later run.
  - These rows no longer complete a task:
    - A `gate.executed` row appended through `exarchos_event`. The generic append now refuses the type.
    - A copy of a runner row without its runner key.
    - A runner row with no task id, from a run of `check_static_analysis` with no `taskId`.
    - A row that names its task only at the top-level `data.taskId`.
  - The active records of a task are the records of the phase attempt of its latest static-analysis record. A record of an earlier phase attempt does not count. A run supersedes only a run of its own phase attempt, and the latest attempt holds the current evidence. Inside that phase attempt, the active records include the runs on other branches and on other bases. A run supersedes only an earlier run with the same `branch` and `baseBranch`. Thus a failing run on another base refuses the completion until a run on that base passes.
  - After `STATE_SYNC_FAILED`, a retry of `task_complete` returns the stored `task.completed` row while the state document shows the task with a status other than `complete`. The retry syncs the document again and does not check the gate, so a later failing run does not refuse the retry.
  - A call whose keyed append finds its key returns the stored row and appends nothing, for example a retry of `task_complete`. The emission check and the ensures check of dispatch now read the stored row that the reply acknowledges. They count that row as the declared emission of the call. Before this change, dispatch refused such a retry with `EMISSION_CONTRACT_VIOLATED`.
  - When the state document already shows the task as `complete`, `task_complete` checks the gate again. This applies after `exarchos_workflow reconcile` and to the `task-fix` runbook on a completed task. A later failing run then refuses, and a later pass returns the stored row.
  - A repository with no supported static-analysis toolchain cannot record a `task.completed` row: `task_complete` and `settle` refuse. A rerun gives the same skip, so this build has no recovery for it. A later change lets static analysis run configured commands ([#1540](https://github.com/lvlup-sw/exarchos/issues/1540)).
  - A repository whose static analysis is inconclusive cannot record a `task.completed` row: `task_complete` and `settle` refuse. The runner row of an inconclusive run has `passed: false`, and its evidence verdict is `indeterminate`.
    - A Node project is inconclusive when `package.json` has no `lint`, `typecheck` or `quality-check` script. `quality-check` is a script name of Exarchos, so most Node projects do not have it.
    - A run with `skipLint` or `skipTypecheck` is also inconclusive when the flag skips a check.
    - Recovery: add the missing scripts to `package.json`, or do not set the skip flags. Then run `exarchos_orchestrate check_static_analysis` with `taskId`, `repoRoot: 'auto'` and the `worktreePath` of the task, and call `task_complete` again. Under `settle`, settle the claim under a new batch id instead.
  - Limit: the state document is a second route to a complete task, and this change does not close it. `exarchos_workflow update` and a generic `state.patched` append can set `tasks[].status` to `complete` with no gate run. The transition guards and the frontier of `prepare` read that field. [#1927](https://github.com/lvlup-sw/exarchos/issues/1927) owns the route for the transition guards, because the state document retires as a guard input. No issue owns it for the frontier of `prepare` yet.
  - Limit: this change lands the forged-row half of the completion defect of [#1886](https://github.com/lvlup-sw/exarchos/issues/1886). The generic append cannot write the row, and the reader needs a runner row and an evidence record for the task. The note on the named tree of `task_complete`, above, closes the wrong-tree half on a stream whose capsule pins a scope ([#1929](https://github.com/lvlup-sw/exarchos/issues/1929)). On a stream with no prepared record, a pass on a directory that the completion names still completes the task ([#1927](https://github.com/lvlup-sw/exarchos/issues/1927)).
  - A config hook under `hooks.on['gate.executed']` no longer fires. Config hooks fire only after a generic append, and the generic append refuses the type.
  - Recovery: run `exarchos_orchestrate check_static_analysis` with `taskId`, `repoRoot: 'auto'` and the `worktreePath` of the task, then call `task_complete` again. Under `settle`, correct the cause and settle the claim under a new batch id instead. The refusal `GATE_NOT_PASSED` names the cause and these steps.

- **Use one Exarchos build for each store.** Builds that use the same state directory share one store. An earlier build, such as 2.12.x, accepts a generic append of `gate.executed`, and its `task_complete` accepts rows that this build refuses. Thus every MCP registration of `exarchos`, the `exarchos` binary on `PATH` that the hooks of `hooks/hooks.json` run, and the CLI must start the same build. An MCP server keeps its process until its session ends.
  - Recovery: after you change the binary, restart every session, so that no session keeps a server of the earlier build.

- **The kill probe runs the scoped tests on the task source before it reverts the source.** This is a change of behavior. Before this change, the probe read each failed run after the revert as a kill. Thus a test command that failed for any reason passed every medium-tier and high-tier task.
  - Exit 0 of the test command is a green run. A red run is exit 1, or, for a command of a built-in toolchain, the red codes of that toolchain in place of 1. The registry gives 101 for `cargo test`, 8 for `ctest`, and 1 or 2 for `pytest`, `dotnet test`, `mix test` and `composer test`. A command gets the codes of the registry only when it is the command that the detection of its toolchain gives. With any other command, only exit 1 is red.
  - A red run before the revert gives the indeterminate cause `baseline-red`. The report ends with the tail of the runner output.
  - A run with no verdict gives the indeterminate cause `run-no-verdict`, before or after the revert. The causes are an exit code that is not 0 and not red, a signal and the time limit of 120 s. More than 1 MiB of output, a command that does not start and no command are causes too. Such a run is never a kill. The report names the cause and its fact, such as the exit code.
  - `baseline-red` and `run-no-verdict` block `check_test_adequacy` at every tier, in `enforce` mode with a blocking severity. In `audit` mode (a `oneshot` workflow) or under a `warning` severity, the reply is a pass with a warning, and the evidence record keeps `indeterminate`.
  - The result of `check_test_adequacy` states its verdict in two fields: `verdict` (`pass`, `fail` or `indeterminate`) and `completeness`. The evidence verdict of `baseline-red` and of `run-no-verdict` is now `indeterminate`, not `fail`. Transition admission then reports `EVALUATOR_FAILED`, not `failed`, and still blocks. The other blocking causes keep `fail`. The runner row of the gate copies `completeness` into `details`, and the evidence record does not get it. A carrier with no `verdict` field, such as one of an earlier build, is read as before.
  - Limit: some runners exit with a code other than 1 when a test fails. When the registry has no row for such a runner, the run after the revert gives `run-no-verdict`, and the probe blocks.
  - Recovery: set a `test` command in `.exarchos.yml`, or a `test:files` script in a Node project, that exits 1 when a test fails. The report names the exit code and the codes that read as red. A later change makes the codes configurable ([#1540](https://github.com/lvlup-sw/exarchos/issues/1540)).
  - A task that changes only test files runs its tests once. Green tests give `failed`, as before.
  - The probe does not revert test files or test-support files. A test-support file is not a test, and a directory segment of its path is `tests`, `test`, `__tests__`, `__mocks__`, `__fixtures__`, `fixtures` or `test-helpers`. Thus a helper that the task changes stays in place for the run after the revert.
  - Recovery: when the report says that the task changes no source file, look for changed source under such a directory. To give the probe a source file to revert, move that source to a path with no such segment. The table is fixed in this build, and a later change makes it configurable ([#1540](https://github.com/lvlup-sw/exarchos/issues/1540)).
  - The probe does not run a test file that the task deletes. When no other test file changes, the verdict is `no-new-tests`.
  - The probe reads the task diff with rename detection off. A renamed source file reverts to its path at the base for the run after the revert. A deleted source file comes back for that run too.
  - The restore after the probe removes a tracked path that the snapshot does not hold. Before this change, a deleted source file that the revert brought back stayed in the task worktree as a staged addition.
  - Each scoped test run gets a new scratch directory. The store keys of its environment, such as `WORKFLOW_STATE_DIR`, point into that directory, and `CLAUDE_PLUGIN_ROOT` and `EXARCHOS_PLUGIN_ROOT` are removed. Thus the tests of a task cannot write the live store.
  - The probe runs the `test:files` script of `package.json` when it exists, as `npm run test:files -- <files>`. A pnpm, yarn or bun project uses its own `run test:files` form. The script must run only the files that it gets. Without the script, the probe runs the resolved test command with `-- <files>`, as before.
  - This repository adds that script. Its `npm run test:run` runs only the `unit` project, so it collects no file under `tests/unit`. `npm run test:files` refuses to start without a file argument. For a file under `tests/process`, it builds the binary of the working tree and puts it first on `PATH`. Thus both runs test the tree that the probe sees.
  - Recovery: make the scoped tests pass on the task source, then run `check_test_adequacy` again.
  - Limit: the probe reads each red run after the revert as a kill. A test that does not load after the revert is red, such as a test that imports a module that the task adds or renames. The revert of a config file, such as `package.json`, can also make that run red or collect no test.
  - Limit: on a .NET repository that runs Microsoft.Testing.Platform, `dotnet test -- <file>` exits 5 on the task source and on the reverted source. The probe gives `run-no-verdict` and blocks until per-language commands land ([#1540](https://github.com/lvlup-sw/exarchos/issues/1540)).
  - Limit: when the revert makes a `conftest.py` fail to load, `pytest` exits 4, and the probe gives `run-no-verdict`.
  - Limit: `cargo test -- <path>` and `ctest -- <files>` can give a green run that tests nothing, so the probe gives `failed`. This limit is older than this change.

- **The import-boundary check of `check_static_analysis` scans only the first-party sources, and a run with no verdict does not fail the gate.** This is a change of behavior. Before this change, the check scanned the whole checkout, with nested worktrees and build output. It read each non-zero exit as a FAIL, so a run that ran out of memory failed the gate.
  - The check scans the roots of the `ownership.firstParty` globs in `.exarchos.yml`. The default globs are `src/**` and `servers/*/src/**`. The check does not scan a root that does not exist. A module outside the roots is checked only when a first-party file imports it.
  - A glob whose walk stops at its first segment, such as `**/src/**`, widens the scan to the repository root. The check does not apply a negated glob. The report names each such glob, each negated glob and each glob that names no path, also for a PASS.
  - Recovery: when the report says that no `ownership.firstParty` source root exists, set `ownership.firstParty` in `.exarchos.yml` to globs that name the source directories. Then run `check_static_analysis` again.
  - Recovery: when first-party sources are outside the roots of the globs, such as `lib/` beside `src/`, add a glob for each such directory to `ownership.firstParty`. The check does not see such a directory, so the report does not name it.
  - When `.exarchos.yml` exists and does not load or cannot be read, the check fails, and the report names the file and the error. The check does not scan the default roots in place of the configured ones. This applies only to a repository with a `.dependency-cruiser.*` config. For such a file, the mock-boundary gate keeps its default globs and severity, and its result names the error in `configLoadError`.
  - Recovery: correct `.exarchos.yml` or the cause of the read error. Then run `check_static_analysis` again.
  - The check runs the `node_modules/.bin/depcruise` that the repository installed, or `depcruise.cmd` on Windows. It looks in the repository root and then in each parent directory, as npm does. It never runs `npx`, so it fetches nothing from the registry.
  - Recovery: when the report says that no local `depcruise` exists, install dependency-cruiser in the repository, for example with `npm install --save-dev dependency-cruiser`. Then run `check_static_analysis` again.
  - The verdict is `summary.error` in the JSON report of dependency-cruiser, not the exit code. Before this change, 256 error violations gave exit 0 and a false PASS.
  - A run with no verdict is a visible skip. The causes are no local `depcruise`, a tool that did not start, a signal, a heap exhaustion, output past the buffer limit, the exit status of a signal stop or of a missing command, no first-party root, and a scan that checked no module (`summary.totalCruised` is 0). The report lists the skip with its cause, and the result line says `degraded: 1 advisory check gave no verdict`.
  - A broken config or a usage error fails the check. An example is exit 1 with an `ERROR:` line on stderr and no complete JSON report. A run that gives no complete report and shows no fault outside the repository fails too. The report quotes the stderr and names the command to re-run for the full output.
  - A skip with no verdict does not fail the gate. When the other checks pass, the result has `verdict: 'pass'`, `passed: true`, `completeness: 'degraded'` and `advisorySkips`, with the name, the cause and the detail of each skip. The evidence verdict is `pass`. In these notes, `degraded` has one meaning: a verdict that leaves out an advisory check, because that check gave no verdict.
  - Limit: the older field `degraded: true` keeps its earlier meaning too. An inconclusive run, with `skipReason: 'constituent-skipped'`, also has it, and its report says `Result: DEGRADED`. Read `completeness` to find a degraded verdict.
  - The result of `check_static_analysis` now states its verdict in two fields, as the result of `check_test_adequacy` does: `verdict` and `completeness` (`complete` or `degraded`). The verdict is `pass`, `fail`, or `indeterminate` for an inconclusive run or a repository with no toolchain.
  - In a repository without a `.dependency-cruiser.*` config, the boundary check does not run, as before.
  - The runner of the static-analysis checks accepts 64 MiB of output, not 1 MiB. Before this change, a check with more output than 1 MiB failed. Now it gives its real verdict.
  - The boundary-parse taint check gives a skip, not a FAIL, when `semgrep` does not start (`ENOENT`), when its output passes the runner limit (`ENOBUFS`), or when a signal stops it. Before this change, the runner gave exit 1 for these runs, and the check read exit 1 as a finding.
  - A taint skip of a repository with a `.semgrep/no-raw-io-into-core.yml` ruleset is now visible, as for the boundary check. The report lists it with its cause, and the result line says `degraded`. The causes are the three above, a heap exhaustion, and the exit status of a signal stop or of a missing command. Exit 2 of `semgrep` with the text of an engine out of memory or of an install with no engine is a skip too.
  - The taint check now fails on a ruleset or a usage error, which `semgrep` gives as exit 4, 5, 7 or 8. It also fails on each other exit that names no fault outside the repository, such as exit 2 with no text. Before this change, each such exit was a skip that the report did not show.
  - Limit: the check runs `semgrep --quiet`, and `--quiet` hides the messages of `semgrep`. Thus an engine that ran out of memory can exit 2 with no text, and the check then fails.
  - Recovery: when the taint check fails, re-run the command that the report names without `--quiet`, and read the message of `semgrep`. Then correct the ruleset, or give the engine more memory, and run `check_static_analysis` again.
  - The gate runner copies `completeness` into the `details` of the `gate.executed` row. For a degraded verdict, it also copies `advisorySkips`, with the name and the cause of each skip. The verification trace of a task on the `settle` receipt lists in `qualifiers` each gate of its segment whose row is degraded or a skip. A skip by the verification policy is not listed. The output schema of `settle` does not name `qualifiers`, and it admits the field.
  - The evidence record and the settlement bundle do not get the mark or its causes, so no stored shape changes. The field of the evidence record waits for a later step of the store version, after the repair of [#2106](https://github.com/lvlup-sw/exarchos/issues/2106).
  - Recovery: when the result line says `degraded: N advisory check gave no verdict`, read the cause of each advisory skip in the report. Install `semgrep` when the taint check did not start. Then run `check_static_analysis` again.

- **The settlement vocabulary is a one-way upgrade, and the store schema stays V6.** This build gives three more settlement outcomes (`recompile-required`, `corrective-capsule`, `accepted-with-rationale`). A claim can carry a `status`, a `reason` and a `rationale`. The `execution.settled` row has two optional fields (`unresolvedTasks`, `rationales`). `SCHEMA_VERSION` stays 6, so no migration runs, and the store records no new version.
  - After this build settles a batch, a 2.12.x binary cannot read the settlement records of that workflow. It gives false refusals and `INTERNAL_ERROR` on them. Downgrade to 2.12.x is not supported.
  - This build replays and decides a batch that 2.12.x recorded, with one limit. The retry of a 2.12.x batch whose request repeated a deviation, or held more than sixteen deviations, does not replay its verdict. The decision of such a held batch still works.
  - The store version moves in a later release, with a step that only stamps the version, after the freshness gate is repaired ([#2106](https://github.com/lvlup-sw/exarchos/issues/2106)).
  - `tools/audit/registered-actions-snapshot.json` holds a digest of each stored settlement shape and the version decision for it. `tests/architecture/identifier-stability.test.ts` fails when a shape changes and no decision records it.

- **The skills install of a release build is pinned to its version.** When no local skills tree is found, `exarchos onboard` runs `npx skills@1 add github:lvlup-sw/exarchos#v<version>`, so a release binary installs the skills of its own release with major version 1 of the `skills` CLI. A release build is a binary that the build made with HEAD at the tag `v<version>`, as the release workflow does. The install fails when that tag is not published.
  - A binary built from another commit carries the version of the last release. It is not a release build, so it installs the default branch, and the installer says so.
  - The npm package ships the binaries that the release job builds at the tag. They are release builds, so they install the skills of their tag.
  - Only a run from source has no build version. There a version of release form installs its tag. A version that is not of release form installs the default branch, and the installer says so.
  - A 2.12.1 binary has no ref in that command, and it installs the skills of the default branch until a 3.x binary replaces it.

- **`task_complete` refuses a task that a later design revision names.** This is a change of behavior. When a design revision after the capsule of the task names the task, the call refuses with `TASK_SUPERSEDED_BY_REVISION` and writes no row.
  - `task_complete` takes an optional `capsuleVersion`. The check reads the revisions after the prepared record of that capsule. With no `capsuleVersion`, it reads the revisions after the latest prepared record. A stream with no prepared record holds no revision, so there the check passes.
  - A `capsuleVersion` with no prepared record refuses with `CAPSULE_NOT_PREPARED`. The refusal tells the caller to pass the `capsuleVersion` that `prepare` returned.
  - A retry of a recorded completion returns the stored row, also after a later revision. When a `task.failed` row follows the stored completion, the revision check and the gate check run again.
  - Each attempt reads the tail of the stream first, and its append expects that tail. Any append to the stream between the read and the append starts the next attempt. After eight attempts, the call returns `CONCURRENCY_CONFLICT`, and the next call starts again.
  - `settle` sends the capsule version of its batch to the completion leaf of each segment. The `task.completed` row does not record the version.
  - The merged input schema of `exarchos_orchestrate` in `tools/list` now gives `capsuleVersion` the shorter text of `task_complete`: "The capsule version prepare returned". The describe of `settle` keeps its own text.
  - Recovery: when `task_complete` refuses with `TASK_SUPERSEDED_BY_REVISION`, run `prepare` again. Then complete the task under the new capsule.
  - Limit: a direct `task_complete` with no `capsuleVersion` checks against the latest prepared record. After a continuation is prepared, it thus completes a task also for work done under the earlier terms. Only `settle` pins the capsule of the work.
  - Limit: a task can have a completion row and then a `task.failed` row. The next `task_complete` of that task runs the revision check, but its append finds the stored completion key. Thus the pinned tail does not apply, and a revision between the read and the append is not caught. No row is written, but the state document marks the task complete.

- **`settle` judges its batch again inside its commit.** This is a change of behavior. Before this change, `settle` read the completion rows and the design revisions before its commit, and the commit compared none of them. When another call appended a row in that window, the record was wrong.
  - `settle` judges the batch from the rows of the stream before its segments and again after them. Inside its write transaction, it judges the batch a third time. When that judgement differs, the commit appends nothing, and the call reads and judges again. A redo runs only the segments that the new judgement needs and that the call did not run.
  - A completion row that another call appends before the commit is read inside the commit. A required task that the row completes needs no claim. A claim with a status for that task gives `already-complete`.
  - A revision that commits while `settle` works makes the batch `recompile-required` when it names a claimed task or an unfinished required task.
  - After three attempts, the call returns `CONCURRENCY_CONFLICT` and records no verdict. The tasks that its segments verified stay complete.
  - Recovery: when `settle` returns `CONCURRENCY_CONFLICT`, settle the same batchId again. The retry replays the segments that the batch committed, and it runs none of their gates again.
  - A task that a segment verified before a read changed stays complete. Thus a `recompile-required` or `rejected` receipt can list such tasks in `verification`. Under such an outcome, `acceptedTasks` lists the claims with no finding. These outcomes verify nothing at the read of the batch.
  - Under every outcome, `settle` updates the state document before it records the verdict for each task that its own halted segment completed. When the document cannot be updated, the call returns `STATE_SYNC_FAILED` and records no verdict.
  - Recovery: when `settle` returns `STATE_SYNC_FAILED`, run `exarchos_workflow reconcile`, then settle the same batchId again.
  - A completion leaf inside a segment can halt in two more ways. `task_complete` refuses the task, or it loses the tail of the stream eight times in a row. Every append to the stream moves its tail, also an append of a parallel teammate. When the batch still verifies at the read after the segments, the call fails with `INTENT_SEGMENT_FAILED`.
  - Recovery: when a completion leaf halts the segment, settle the claims under a new batchId.
  - Limit: a retry of the same batchId gets the recorded halt of a completion leaf again. A halt that a retry of the same batch can clear needs a change of the executor, a follow-up of [#1929](https://github.com/lvlup-sw/exarchos/issues/1929).
  - Limit: the plan half of the standing of a task that a deviation names comes from `tasks[]` of the workflow state. `settle` reads it before the commit only. A `state.patched` row that marks such a task complete inside the window is not compared ([#1927](https://github.com/lvlup-sw/exarchos/issues/1927)).

- **A decision round that accepts a deviation naming a finished task is `rejected`.** This is a change of behavior. Before this change, the decision round did not read the standing of the tasks that a held deviation names. When a second batch finished such a task while the first batch was held, the accepted decision revised a finished task.
  - The round reads the decision of each deviation first. A rejected deviation gives `deviation-rejected`, as before. An accepted deviation that names a finished task gives `deviation-names-finished-task`, and the outcome is `rejected`.
  - A task is finished when the stream holds its completion row, or when the plan shows it complete. Each other task is pending, also a task that left the plan. When the plan does not resolve, the round reads the completion rows alone.
  - That deviation records no design revision. Each other accepted material deviation of the round still records its revision.
  - The round judges again inside its commit. Thus a task that completes between the read of the round and its commit gives the same finding.
  - Recovery: plan the rework as a new task, and name the new task.

- **A batch whose segments an earlier build ran gets `OPERATION_DIGEST_MISMATCH` when it is settled again, unless its verdict was recorded.** The arguments of each segment now hold `capsuleVersion`, and the request digest of a segment covers each argument. The request of a segment of an earlier build has no such argument. The executor reports `INTENT_REPLAY_DIGEST_MISMATCH` for the segment, and `settle` refuses the call. A batch with a recorded verdict replays that verdict, as before.
  - Recovery: when a batch of an earlier build gets this refusal, settle its claims under a new batchId.

- **The four `exarchos_event` actions declare the shape of their success data.** The `outputSchema` of `append`, `batch_append`, `query` and `describe` no longer gives `data` as an unknown value. `describe` shows each shape, and the MCP adapter checks each reply against it.
  - A `query` row that holds `streamId`, `sequence`, `type` or `timestamp` must give it its stored type. A `fields` projection can omit each of them.
  - The `describe` data must hold one of `actions`, `eventTypes` or `emissionGuide`, and no other key.
  - The economy budget of the event `describe` is now 16000 tokens, up from 12000. Thus a describe of the four actions with their larger schemas is not marked `economyDegraded`.

### Changed

- **The `query` mode of `exarchos_workflow get` now returns `{ <query>: <value> }`, not the bare value.** This is a change of behavior. A query of `phase` returns `{ "phase": "plan" }`. A path that resolves to nothing returns `{}`, because the query omits an absent key as a `fields` projection does. Thus `data` is an object in each read mode, and `exarchos wf status -q` returns the same object.
  - The `outputSchema` of `get` now declares its success data. A bare scalar, an array, `null` or a `phase` that is not a string fails the parse. The MCP adapter checks each reply against it.
  - Migration: read the value under the query key, for example `data.phase` for `query: "phase"`. A query of `tasks[0].status` returns the value under the key `"tasks[0].status"`.

- **The other eleven workflow-platform actions declare the shape of their success data.** They are `init`, `transition`, `update`, `cancel`, `cleanup`, `reconcile`, `checkpoint`, `feedback`, `rehydrate` and `describe` of `exarchos_workflow`, and `exarchos_sync now`. Their `outputSchema` no longer gives `data` as an unknown value. `describe` shows each shape, and the MCP adapter checks each reply against it.
  - `transition` and `update` share one schema with the two arms of the `handleSet` result. The schema of `transition` no longer declares a `_meta.deprecation` slot, because the action does not emit it.
  - `cancel` and `cleanup` admit the dry-run arm and the done arm. `rehydrate` admits the strict v:4 rehydration document on the fresh path and on the degraded path.
  - The workflow `describe` data keys each action entry by the action name. It holds `topology`, `playbook` or `config` only on request, and an empty object fails the parse.
  - The vacuity allowlist now holds no waiver that expires on 2026-12-06.

### Fixed

- `exarchos onboard` and `exarchos doctor --fix` register the Claude Code MCP server in `~/.claude.json` as `exarchos mcp`, the command of the plugin manifest. Before this change, they wrote an entry that started `node ~/.claude/mcp-servers/exarchos-mcp.js`, and no install step creates that file.
  - The `agent-mcp-registered` doctor check now gives Warning for that stale entry, also when the exarchos plugin serves the project. Onboard and `doctor --fix` replace the entry without `--force`. When the plugin serves the project, they remove the entry and add none.
  - They add no entry when the exarchos plugin already starts the server in this project. This needs an install record for this project and a settings file that turns the plugin on. A `user` or `managed` install serves each project, and a `project` or `local` install serves its own project. The doctor check uses the same rule.
  - A plugin that no settings file names in `enabledPlugins` does not count, because Claude Code does not load it. Onboard then writes the `~/.claude.json` entry.
  - Each other existing `exarchos` entry stays unless `--force` is given. When the plugin serves the project, it stays also with `--force`.
  - The doctor fix text now names `exarchos onboard`, not the `exarchos init` rename stub.
- `exarchos_workflow cancel` writes its trail events (`workflow.transition` and `workflow.cancel`) with `correlationId` set to the feature id and `source` set to `workflow`, as `init`, `set` and `cleanup` do. Before this change, the events had no `source`, and outside a dispatch they had no `correlationId`. Under a dispatch, they carried the correlation id of the dispatch.

### Removed

- The unused MCP bundle copy (`src/install/operations/bundle.ts`) and the unused MCP entry helpers (`src/install/operations/mcp.ts`). No install path called them.
- The unused remote-MCP skeleton `src/adapters/mcp/remote-mcp.ts` and the dormant benchmark baseline schema `tools/evals/benchmarks/baselines-schema.ts` are deleted at the expiry of their RESERVED headers on 2026-10-31. `doctor` no longer reports the `remote-mcp` check, which always gave `Skipped`, so it now runs 19 checks.

## [2.10.0-preview.4] - 2026-05-24

Final feature-work batch of the v2.10.0 line before RC. Ships the substrate that consumes the v2.10.0-preview.3 Wave 0 carrier — Roots-based workspace discovery, three-field correlation, Tasks (SEP-1686) dispatch-core, Elicitation form-mode, quality hints, plus the authoring substrate (`/ideate` first-turn invariants, designs/plans sidecar, handoff lint). The substrate landed first (PRs #1421–#1435), then an immediate post-bundle audit cycle closed three HIGH-severity TaskStore correctness findings, the correlation contract end-to-end (storage + filter layer + consumer wiring), substrate hygiene, elicitation E2E verification (which surfaced and fixed a wired-but-not-invoked Zod-v4 narrowing bug mid-bundle), and an invariants-catalog rewrite (schema v1→v2).

After this preview, **v2.10.0 transitions to release-candidate mode** — RC ships polish + bug fixes only (no new API surface, no new event types, no new MCP capabilities).

Tracked under epic [#1441](https://github.com/lvlup-sw/exarchos/issues/1441) (substrate + polish; CLOSED 2026-05-24) and the bonus axis #1458/#1459 (invariants v2).

### Substrate bundle — Wave A: Output contract completion

- **next_actions Zod discriminated unions + fail-closed `safeParse`** ([#1238](https://github.com/lvlup-sw/exarchos/issues/1238), PR [#1421](https://github.com/lvlup-sw/exarchos/pull/1421))
  - `nextActionsFromResult` no longer uses `Record<string, unknown>` casts + inline `typeof` guards. Replaced with `ShapeOneSchema | ShapeTwoSchema` discriminated union consumed via `safeParse`. Fail-closed on no-match (the previous silent `return []` now returns the same empty list but via Zod's parser, so shape regressions are observable through the union's failure surface rather than hidden by the cast). Preserves no-actions case for non-success / null-data inputs.

- **`output_tokens_high` quality hint** ([#1262](https://github.com/lvlup-sw/exarchos/issues/1262), PR [#1409](https://github.com/lvlup-sw/exarchos/pull/1409))
  - Edge-triggered hint emitted via `next_actions` when per-turn output tokens cross a configurable threshold (default 80% of cap). Suggests `checkpoint` as next action. Threshold reads through `CapabilityResolver`, not raw YAML. Registers against `exarchos_view.describe` action discovery.

- **Roots-based workspace discovery** ([#1290](https://github.com/lvlup-sw/exarchos/issues/1290), PR [#1410](https://github.com/lvlup-sw/exarchos/pull/1410))
  - When `featureId` is omitted on a dispatch that requires it AND the client declared `roots: { listChanged: true }`, server calls `roots/list` (cached per-handshake; refreshed on `roots/list_changed`), scans each root for an Exarchos workspace signature (`.exarchos.yml`, `docs/workflow-state/*.state.json`), and resolves. One match → success + `workspace.resolved {source: 'roots', path, featureId}`. Zero matches → fall back to cwd-walk + `workspace.resolved {source: 'cwd'}`. Multiple matches → `INVALID_INPUT` with `validTargets` populated. CLI surface unchanged (no `roots` over CLI).

- **Elicitation form mode for `INVALID_INPUT`** ([#1274](https://github.com/lvlup-sw/exarchos/issues/1274), PR [#1424](https://github.com/lvlup-sw/exarchos/pull/1424))
  - When `dispatch()` finds a missing required parameter AND the client declared the `elicitation` capability, server derives the field's sub-schema via `inputSchema.pick({field: true})` and sends `elicitation/create` instead of returning `INVALID_INPUT`. Schemas are **derived, not hand-written** — Zod's `.pick()` ensures elicitation can't drift from validation (DIM-3). Emits `elicitation.requested` and `elicitation.fulfilled` events carrying `operationId`. Legacy `INVALID_INPUT` remains as fallback for clients without the capability.

### Substrate bundle — Wave B: Correlation + event topology

- **Three-field dispatch-boundary correlation** ([#1291](https://github.com/lvlup-sw/exarchos/issues/1291), PR [#1428](https://github.com/lvlup-sw/exarchos/pull/1428))
  - `DispatchContext` mints `operationId` / `correlationId` / `causationId` at dispatch entry; threaded via `AsyncLocalStorage` through every event emitted during the call, the envelope's `_meta`, and the auto-emit chain. `correlationId` lets `/loop` cycles and subagent waves share a thread; `causationId` lets reconstruction answer *why* without timestamp heuristics. Backwards-compatible: existing single-`operationId` events get widened, never removed. Storage layer + telemetry filters shipped separately under #1437/#1447 (see post-bundle polish below).

- **`dispatch.preflight` + `stash.detected` events** ([#1261](https://github.com/lvlup-sw/exarchos/issues/1261), via PR #1428's squash)
  - `dispatch-guard.ts` emits `dispatch.preflight { guards: { ancestry, worktree, protectedBranch, mainWorktree }, passed, durationMs }` after each guard pass-or-fail, and `stash.detected { worktreePath, stashRef }` when a guard observes shared-stash state. Threads three-field correlation. Per-guard attribution unlocks future epic-autopilot signals.

- **`EventSourcedTaskStore` — TaskStore as projection** ([#1272](https://github.com/lvlup-sw/exarchos/issues/1272), via PR #1428's squash)
  - The SDK's `TaskStore` interface implemented as a projection over `task.created`, `task.polled`, `task.result`, `task.cancelled` events. SDK's `InMemoryTaskStore` is **not** used — `production-wiring.test.ts` asserts it absent. Lives next to the event store (INV-3 basileus-forward). Bounded retention via per-task TTL. Each event carries three-field correlation.

### Substrate bundle — Wave C: Tasks (SEP-1686) dispatch-core ([#1273](https://github.com/lvlup-sw/exarchos/issues/1273))

A dispatch-core abstraction, not an MCP-adapter feature. Both CLI `--follow` and MCP `tools/call` (with `task: { ttl }` augmentation) consume the same dispatch path, same `EventSourcedTaskStore`, same `task.*` event stream.

- **C1 — Tasks-augmented dispatch-core branch** (content rode in under C3's squash; attribution drift documented in bundle audit)
  - Dispatch core gains second return shape: `Envelope<T>` for one-shot, `CreateTaskResult` for tasks-augmented. Lifecycle in `EventSourcedTaskStore`; emits `task.created` → `task.polled` (throttled) → `task.result` or `task.cancelled`.
- **C2 — MCP `tasks/*` methods + `taskSupport` capability** (PR [#1432](https://github.com/lvlup-sw/exarchos/pull/1432))
  - `tasks/call`, `tasks/get`, `tasks/cancel`, `tasks/list` methods on the MCP adapter. `taskSupport` capability handshake gates client-side opt-in.
- **C3 — CLI `--follow` polling loop** (PR [#1433](https://github.com/lvlup-sw/exarchos/pull/1433))
  - Initial coverage: `view workflow_status --follow`, `view shepherd_status --follow`. Expanded by post-bundle #1452 Op 1 to `pipeline` / `convergence` / `delegation_timeline`.
- **C1-fix — `pollInterval` validity + `task.polled.sequence` deprecation** (PR [#1435](https://github.com/lvlup-sw/exarchos/pull/1435))
  - Post-merge CodeRabbit MAJOR follow-ups on #1273 — `pollInterval` normalization in the CLI follow path, deprecation of the `task.polled.sequence` field (internal-facing; not a stable contract).

### Substrate bundle — Wave D: Authoring substrate

- **Machine-readable invariants catalog v1 + vocabulary lint + `/ideate` first-turn surfacing** ([#1260](https://github.com/lvlup-sw/exarchos/issues/1260), PR [#1425](https://github.com/lvlup-sw/exarchos/pull/1425))
  - `docs/architecture/invariants.md` as YAML-fronted markdown (machine-readable source of truth for design-invariants skill). Vocabulary-lint pre-flight rejects undefined invariant references. `/ideate` Phase 0 surfaces relevant invariants on first turn. (v2 schema bump ships under #1459 — see "Bonus axis" below.)

- **Designs/plans machine-readable sidecar** ([#1298](https://github.com/lvlup-sw/exarchos/issues/1298), PR [#1426](https://github.com/lvlup-sw/exarchos/pull/1426))
  - `.sidecar.yml` companion to design/plan markdown — gates read structured fields instead of regex-scraping prose. Includes 4 functional fixes. CodeRabbit caught a near-miss B1 bug where sidecar lookup originally returned `foo.md.sidecar.yml` instead of `foo.sidecar.yml`, which would have made the entire gate path silently dead. Regex-fallback removal tracked under follow-up #1407.

- **Markdown-aware handoff lint at `handleCheckpoint`** ([#1244](https://github.com/lvlup-sw/exarchos/issues/1244), PR [#1427](https://github.com/lvlup-sw/exarchos/pull/1427))
  - Checkpoint handoff text linted against markdown structure expectations (DIM-8). Design deviation from plan: shipped via `result.warnings` + `data.handoffLintFindings` instead of `_eventHints` payload (`EventHintsPayload` is strictly typed). Functionally equivalent.

### Post-bundle polish (epic [#1441](https://github.com/lvlup-sw/exarchos/issues/1441))

The substrate bundle landed first; an immediate post-merge audit cycle (`docs/research/2026-05-16-v2-10-0-preview-4-bundle-audit.md` + `docs/research/2026-05-16-event-sourced-task-store-audit.md`) surfaced 8 net-new findings + 3 pre-existing issues. Rather than block preview.4 on the long tail, the bundle shipped and the polish was tracked under epic #1441. **10/10 substrate-axis sub-issues closed.**

#### HIGH-severity — TaskStore correctness (landed 2026-05-17)

- **Throttle `task.polled` emit** (FINDING-3, PR [#1443](https://github.com/lvlup-sw/exarchos/pull/1443))
  - Closes the write-amplification gate at the design's 250ms CLI poll cadence. Unblocks #1440 adoption-expansion without producing the predicted regression.

- **Thread `expectedSequence` through writes** (FINDING-1, PR [#1445](https://github.com/lvlup-sw/exarchos/pull/1445))
  - Adds OCC to `storeTaskResult` / `updateTaskStatus`. Captures stream tail in `loadTask` → passes through to writers → calls `append` with `expectedSequence`. Closes the Marten C-2 `fetchForWriting` analog the implementation was missing. INV-3 basileus-forward multi-writer correctness.

- **Validate cache against stream tail** (FINDING-2, PR [#1444](https://github.com/lvlup-sw/exarchos/pull/1444))
  - Cache hits now validate against stream tail before serving. Absorbed 5 CodeRabbit hardening commits for cross-process INV-1 consistency: `lastReadSequence` stamping, `expiresAt` derivation, `statusMessage` hygiene in both writer mutate closures and projection folds, `completed`/`failed` guard in `updateTaskStatus`.

#### MEDIUM — Correlation contract end-to-end

- **Correlation tuple indexed columns + telemetry filters** ([#1437](https://github.com/lvlup-sw/exarchos/issues/1437) + [#1414](https://github.com/lvlup-sw/exarchos/issues/1414), PR [#1447](https://github.com/lvlup-sw/exarchos/pull/1447))
  - Schema V5→V6: `operation_id`, `correlation_id`, `causation_id` columns on the `events` table with three indexes (`idx_events_correlation`, `idx_events_causation`, `idx_events_operation`).
  - Chunked transactional backfill from the `payload` JSON via the `migrateV5ToV6` helper; emits `migration.correlation_backfill_progress` events per chunk.
  - `EventStore.QueryFilters` accepts the three correlation fields; `SqliteBackend` honors them as indexed `WHERE` clauses; `InMemoryBackend` uses a post-fetch JS filter for parity.
  - Six telemetry view actions (`telemetry`, `delegation_timeline`, `code_quality`, `quality_correlation`, `quality_attribution`, `eval_results`) accept the new filter args; `exarchos_view describe` surfaces them.
  - `materializeFiltered` cache-bypass helper prevents cache contamination across filtered/unfiltered calls on the same view.
  - Closes the [#1291](https://github.com/lvlup-sw/exarchos/issues/1291) acceptance criteria (storage layer + telemetry filters + three end-to-end integration tests) that PR [#1428](https://github.com/lvlup-sw/exarchos/pull/1428) deferred. Closes [#1414](https://github.com/lvlup-sw/exarchos/issues/1414) (regression coverage proves the inline fix from #1428's post-merge hardening).

- **Correlation consumer wiring** ([#1448](https://github.com/lvlup-sw/exarchos/issues/1448) items 2–5, PR [#1449](https://github.com/lvlup-sw/exarchos/pull/1449))
  - `deriveCorrelationFilters` helper in `views/tools.ts` — inside an active `runWithDispatchContext` scope, defaults `correlationId` to the active dispatch's correlationId when no filter args are supplied; explicit args always win. Emits `source: 'ctx-default'` debug log on the inferred path. Replaces six inline filter-spread blocks across the six telemetry view handlers.
  - CLI flags `--operation-id` / `--correlation-id` / `--causation-id` on all six telemetry view subcommands. Auto-generated from each action's Zod schema in `registry.ts` via `addFlagsFromSchema`; 20 regression-pin tests (full subcommand × flag matrix + introspection sweep + end-to-end smoke through real dispatch).
  - `bypasses` counter on `ViewMaterializer.getCacheStats()` plus `correlationFilteredQueries` counter on `SqliteBackend.getStats()` — close the two DIM-2 LOW findings from PR [#1447](https://github.com/lvlup-sw/exarchos/pull/1447)'s axiom audit (silent index regression + invisible cache-bypass).
  - `docs/runbooks/correlation-filters.md` — operator + agent reference covering the three IDs, filter selection rule, MCP + CLI examples, and the AsyncLocalStorage default. Linked from `README.md` in the agent-first architecture section.

#### MEDIUM — Substrate hygiene (PR [#1450](https://github.com/lvlup-sw/exarchos/pull/1450))

Single bundle covering two parallel-safe waves:

- **Views layer** — Register `session_provenance`, `provenance`, `ideate_readiness` in `TOOL_REGISTRY` (closes [#1446](https://github.com/lvlup-sw/exarchos/issues/1446) — DR-5 schema validation gap). Internal-sentinel skip in `ViewMaterializer`'s stream iterator: streams whose `streamId.startsWith('__')` are excluded from snapshot/load (closes [#1434](https://github.com/lvlup-sw/exarchos/issues/1434) — `exarchos_view pipeline` no longer crashes on `__migration__` stream on upgraded repos).
- **Task-store layer** ([#1438](https://github.com/lvlup-sw/exarchos/issues/1438) FINDING-4..8) — Size-cap reap on `createTask` (`REAP_GROWTH_DELTA = 64` amortization), `logger.warn` on the `request` coerce site in `projectTask`, persist `requestId` on `task.created` payload going forward (with `replayed:${taskId}` synthesizer for existing events), and a co-designed Cursor + Hydration subsystem (stable pagination + bounded hydration) addressing F-5+F-6 as one subsystem rather than independent fixes.

#### MEDIUM — Substrate realization (PR [#1452](https://github.com/lvlup-sw/exarchos/pull/1452))

Moves substrate from "shipped and correct" to "actually used and verified end-to-end."

- **Elicitation form-mode E2E smoketest** ([#1436](https://github.com/lvlup-sw/exarchos/issues/1436)) — three-path in-process MCP client+server fixture using `InMemoryTransport`: **accept** (envelope success + `elicitation.requested` + `elicitation.fulfilled` events on per-operation stream + `_meta.operationId` cross-stream correlation), **decline** (`INVALID_INPUT` envelope + `elicitation.declined` event, no retry), **capability-absent** (legacy `INVALID_INPUT`, no `elicitation/*` streams). Each path asserts both envelope outcome AND event-store emissions.
- **Elicitation Zod v4 narrowing fix** ([#1451](https://github.com/lvlup-sw/exarchos/issues/1451), HIGH, surfaced by the #1436 smoketest mid-bundle) — `extractSingleMissingRequiredField` in `dispatch.ts:178-199` was over-strict (`received !== 'undefined'` only). Doesn't match Zod v4's actual issue shape (`received === undefined` for omitted properties). Every elicitation candidate was rejected — substrate was wired-but-not-invoked in production despite PR #1424 shipping. Fix accepts both string `'undefined'` (v3 signal) and bare `undefined` (v4 omitted property).
- **`--follow` expansion** ([#1440](https://github.com/lvlup-sw/exarchos/issues/1440) Op 1) — `VIEW_FOLLOW_ACTIONS` extracted as top-level constant; now covers `workflow_status`, `shepherd_status`, `pipeline`, `convergence`, `delegation_timeline`. Idempotency audit asserts in source-file regression test: all three new handlers are pure `ViewProjection` folds — no `eventStore.append`, no `*.polled` events.
- **`DispatchHints` annotation + `describe` projection** (#1440 Op 2) — `DispatchHints` interface sibling-level to `CliActionHints` on `ToolAction`; `describe` handler projects `dispatch` field alongside `autoEmits` / `deprecated` / `outputSchema`. Four actions annotated with `dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 }`: `merge_orchestrate`, `request_synthesize`, `cleanup`, `rehydrate`. Annotation is advisory; existing `taskCapabilityGate` at `dispatch/core/dispatch.ts:927-954` remains the binding opt-in.
- **`retry_with_task` next-actions hint** (#1440 Op 4) — New `retry_with_task` verb in the next-actions discriminator. Hint emitted at dispatch boundary when (`success && !taskAugmented && action.dispatch?.taskSuitable && elapsedMs > 10_000`); prepended to `result.next_actions` (non-destructive). Negative test pins missing-`ttl_suggestion_ms` rejection.

  **Deferred to v2.12.0:** Op 3 (workflow-verb wiring through Tasks-augmented dispatch) tracked under [#1453](https://github.com/lvlup-sw/exarchos/issues/1453); Op 5 (SSE for `tasks/subscribe`) tracked under [#1454](https://github.com/lvlup-sw/exarchos/issues/1454). Both need dedicated designs per substrate-realization §7.

#### MEDIUM — Invariants audit pair

- **Invariant content audit + cost-of-load split** ([#1439](https://github.com/lvlup-sw/exarchos/issues/1439), PR [#1455](https://github.com/lvlup-sw/exarchos/pull/1455))
  - 18 entries audited: 11 keep / 5 sharpen / 2 downgrade-to-principle / 0 delete. Three dimension renames to axiom canonical: `vestigial-code → hygiene`, `error-handling → resilience`, `ai-prose-tells → prose-quality`.
  - Cost-of-load split: 4 always-load / 12 reference-only / 2 archivable. Loader gains `loadInvariants(path, { scope: 'core' | 'all' })` with loud-throw on unknown scope (DIM-2 contract).
  - Currency fixes: INV-1 applies-to scope clarified; basileus-boundary broken sibling-repo reference repaired.

- **Phase-transition invariant audit + 6 HIGH closures** ([#1370](https://github.com/lvlup-sw/exarchos/issues/1370), PR [#1457](https://github.com/lvlup-sw/exarchos/pull/1457))
  - Audit across 18 commands: 31 findings (6 HIGH, 13 MEDIUM, 12 LOW). Two systemic patterns surfaced: (1) phase-update bug in 5 commands using rejected `update {phase}` instead of canonical `transition`; (2) auto-chain by literal `Skill({...})` instead of consuming `next_actions`.
  - **Systemic phase-update fix:** `ideate`, `plan`, `oneshot`, `review`, `synthesize` — 11 prose sites split into `update` + `transition` pairs. Adds `phase-transition-prose.test.ts` (18 tests) as canonical-pattern guard.
  - **`delegate.md` fix:** Added per-dispatch `task.assigned` event emission section + replaced "Set phase to 'review'" prose with explicit `transition` calls. Adds `delegate-prose.test.ts` (4 tests).
  - MEDIUM/LOW findings spun out to [#1456](https://github.com/lvlup-sw/exarchos/issues/1456) (status:backlog, v2.11.0).

### Bonus axis — Invariants catalog v2 (#1458 + #1459)

Not in original epic scope; emerged from #1370 + #1439 closure work. Provides the dev-invariants substrate that #1442 (Tier B `/ideate` invariant-surfacing eval, under #1403) will consume.

- **Discover artifacts** (PR [#1458](https://github.com/lvlup-sw/exarchos/pull/1458)) — 5 research docs: workload-agnosticism stress test, runtime-invariants research survey + gap analysis, substrate-vs-authoring boundary, v2 spec proposal.

- **Implementation** (PR [#1459](https://github.com/lvlup-sw/exarchos/pull/1459))
  - **Schema v1→v2:** New required field `axis: substrate | authoring`. New optional fields `citations: string[]`, `axiom_overlap: DIM-N` (format-validated).
  - **Loader gating:** `.exarchos.yml: invariants.devCatalog: enabled | disabled` (default **disabled**, no auto-detection). Scope filter expanded to `'core' | 'substrate' | 'authoring' | 'all'`. Fail-loud on missing `axis` field. Repo-root `.exarchos.yml` declares `invariants.devCatalog: enabled` (explicit opt-in for Exarchos contributors).
  - **INV-1 split** → INV-1 (event-sourcing-integrity, narrowed) + **INV-7** (substrate-serialization) + **INV-8** (idempotency-at-the-boundary).
  - **INV-5b split** → INV-5b (carrier-shape only) + **INV-12** (next-actions-as-affordance).
  - **Six new entries:** INV-9 (HSM-as-state-machine), INV-10 (liveness-event-protocol), INV-11 (posture-declared-capabilities), INV-13 (process-manager-two-event-split), INV-14 (native-primitive-first-recovery), INV-15 (single-machine-frame).
  - **Three sharpenings:** INV-6 elevated to primary workload-agnosticism (`cost-of-load: always-load`); INV-1 canonical citations post-split; INV-4 platform-axis vs INV-6 workload-axis clarifier.
  - **External research grounding:** every new entry has ≥3 citations. Sources include Mohan ARIES 1992, Bernstein & Goodman 1981, Mark Miller *Robust Composition* 2006, Norman 1999 affordance theory, Akka *Effect.thenRun*, Wolverine *AggregateHandler*, Greg Young, anip-protocol (convergent independent design).
  - **`/axiom:design` pairing-discovery fix:** `pairs-with: axiom:backend-quality → axiom:design`; complementarity matrix extended with INV-7..15 + INV-12 rows; `commands/ideate.md` Phase 0 directive adds dev-only gating callout.
  - **27-entry catalog total:** 10 substrate always-load + 9 substrate reference-only + 7 DIM-* axiom pointers + 1 authoring DIM-8.

### Schema migrations

- **V5 → V6 events table** — adds `operation_id`, `correlation_id`, `causation_id` columns + three indexes. Automatic on first open via `migrateV5ToV6`. Chunked transactional backfill from `payload` JSON; emits `migration.correlation_backfill_progress` events per chunk. One-way (no downgrade path); standard schema-migration model (same as preview.2's V3→V4).

- **Invariants catalog schema v1 → v2** — adds required `axis` field, optional `citations` + `axiom_overlap`. Gated behind explicit opt-in (`.exarchos.yml: invariants.devCatalog: enabled`, default disabled). Consumers not opting in see zero behavior change.

### Operator notes

- **No agent-facing breaking changes were called out** in the substrate design, bundle audit, or any PR body. The v2.10.0 line treats this surface area as additive. Three items could surface latent breakage:
  - Schema V5→V6 migration is one-way (downgrade from V6 to V5 is not supported).
  - `next_actions` shape regressions previously masked by `Record<string, unknown>` casts are now visible through the discriminated-union failure surface (still fail-closed; no behavior change at the consumer parser boundary).
  - `task.polled` emit cadence reduced by FINDING-3 throttle; field `task.polled.sequence` deprecated. Both internal-facing.

- **9 new event types** added across the substrate surface (`EVENT_TYPES` count 105 → 114).

- **Release-engineering carry:** PR [#1420](https://github.com/lvlup-sw/exarchos/pull/1420) (the original preview.4 version bump) ghost-merged via stacked `--auto --squash` collapse on 2026-05-16 — GitHub showed MERGED but the merge commit was never reachable from `origin/main`. The bundle landed in main but the version bump and CHANGELOG never did. This release ships a non-stacked replacement that lands directly. Hazard codified in project-memory `feedback_stacked_pr_auto_merge_collapses_granularity`.

### Deferrals (carried to v2.11.0 / v2.12.0)

- [#1453](https://github.com/lvlup-sw/exarchos/issues/1453) — `feat(dispatch): wire orchestration verbs through Tasks-augmented dispatch` (#1440 Op 3, design pending). v2.12.0 — Process Lifecycle Verbs. `status:backlog`.
- [#1454](https://github.com/lvlup-sw/exarchos/issues/1454) — `feat(transport): SSE for tasks/subscribe` (#1440 Op 5, design pending). v2.12.0 — Process Lifecycle Verbs. `status:backlog`.
- [#1456](https://github.com/lvlup-sw/exarchos/issues/1456) — #1370 phase-transition audit MEDIUM/LOW residue. v2.11.0.
- [#1395](https://github.com/lvlup-sw/exarchos/issues/1395) — `_eventHints.missing` auto-emit investigation. Rescoped out of epic #1441 (different workstream); now under v2.10.0 milestone direct.

### Comprehensive build review

See [`docs/research/2026-05-23-v2-10-0-preview-4-build-review.md`](docs/research/2026-05-23-v2-10-0-preview-4-build-review.md) for the full inventory of every PR landed under the preview.4 umbrella, the bundle-audit reconciliation, and the release-engineering analysis.

## [2.10.0-preview.2] - 2026-05-11

### Marten primitives + post-DR-4 cleanup (#1312, #1340, #1313, #1284, #1304, #1314, #1341)

This preview lifts the substrate from atomic-append into an event-sourced aggregate model (Marten R-1 + R-2) with reference consumers, and closes the post-v2.11 DR-4 gap that broke the agent-facing artifact-write surface. Six waves, 55 tasks, ~123 new tests.

#### Wave 0 — Restore `exarchos_workflow.update` action (#1340)
- **Added:** public `update` action on `exarchos_workflow`, mapping to the existing internal `workflow.update()` function. Restores the artifact-write path removed in v2.11's DR-4 substrate cut.
- **Rejects `updates.phase`** with `INVALID_INPUT` + `suggestedFix.params.action === 'transition'`. Preserves DR-4's intent (phase changes route through `transition`) while restoring the non-phase mutation surface.
- **Registered:** `WorkflowUpdateOutputSchema` for #1266 envelope-version discipline.
- **Envelope:** `update` returns `_meta.checkpointAdvised`, `next_actions` (HSM-derived for current phase), `_perf` per INV-5b.

#### Wave 1 — R-1: mandatory `workflow_type` column on streams (#1313)
- **Schema migration V3 → V4.** `streams` table gains `workflow_type TEXT NOT NULL` with `'__legacy'` backfill sentinel + `idx_streams_workflow_type` + composite `idx_streams_workflow_type_status`.
- **Sole writer:** `workflow.init` writes the column at stream creation; immutable thereafter. CI grep gate forbids `UPDATE streams SET workflow_type` outside the migration's allowed backfill.
- **Backfill discipline:** primary source is each stream's `workflow.started` event payload (`data.workflowType`); secondary fallback is the workflow-state file. Un-recoverable streams retain `'__legacy'` and emit `migration.workflow_type_unknown` for operator visibility.
- **Validator:** `workflow.init` rejects calls without explicit `workflowType` (Zod validation; previous calls returned vague errors).
- **`PRAGMA busy_timeout = 5000`** added in `applyConnectionPragmas` as a C-layer safety net. Two-tier model: SQLite gets a 5s window to resolve cross-process contention before throwing `SQLITE_BUSY` to the JS-layer's bounded retry budget (`SQLITE_BUSY_RETRY_POLICY`, ~75ms). Audit §F2.2.
- **Read side deferred to v2.12 (#1090)** — filtered `exarchos_view({action: 'ps', workflowType: ...})` lands with the lifecycle verbs.

#### Wave 2A — EventSourcedTaskStore as global projection (#1284)

> **Retired under #1342 — this Wave's global scope no longer exists.** The entries below record what preview.2 shipped and are kept for history; do not read them as current API. `readProjection<T>`, `ReadProjectionOptions`, `InvalidReducerScopeError`, `projections/cadence.ts`, and the `'global'` member of `ProjectionScope` were all **removed**, and `task-store@v1` is now `scope: 'stream'`. Reason: the global fold was incorrect, not merely unused — `TaskStoreState.tasks` is keyed by a bare per-feature ordinal (`'001'`) and `TaskRecord` carries no `featureId`, so folding all streams together merged feature-A's task `001` into feature-B's. It had no consumers, which is the only thing that kept the defect latent. `ProjectionScope` is now the single literal `'stream'`, making the corrupting fold unrepresentable at compile time; the per-stream primitives therefore need no runtime scope check. Read a task store via `decide` / `withSession` / `aggregateStream` on one stream.

- **TaskStore is now a reducer** (`task-store@v1`, `scope: 'global'`) folding over all `task.*` events across all streams. No `InMemoryTaskStore` class existed previously — this is greenfield, not a migration. Closes INV-1's stores-as-projections rule for tasks.
- **New primitive:** `readProjection<T>(reducerId)` in `projections/store.ts`. Validates `scope === 'global'`; reads latest snapshot via `readLatestSnapshot` (key: reducer id), folds events since the snapshot, returns final state. Rejects per-stream-scoped reducers with `INVALID_REDUCER_SCOPE`.
- **Migrated readers:** `views/task-detail-view.ts` and `views/workflow-status-view.ts` compose over `task-store@v1` projection instead of folding events directly. Eliminates per-view duplicate folds.
- **BC preserved:** view-layer `TaskDetail.title: string` contract unchanged (projects via `title: record.title ?? ''`).

#### Wave 2B — mergeOrchestrator as per-stream projection (#1304)
- **MergeOrchestratorState** is now a reducer (`merge-orchestrator@v1`, `scope: 'stream'`) folding `merge.*` events on the feature stream. State machine: `idle → preflight → requested → executed → completed`; any phase → `recovering` on `merge.rollback`.
- **New event type registered:** `merge.requested` in `event-store/schemas.ts` (model-emitted, `.describe()` on every field). The `requested` phase is the durable intent captured before the side-effect fires (audit §F1.2 — the canonical two-event-split pattern foundation).
- **Closes the last in-memory side-database** for merge state. INV-1 stores-as-projections satisfied across both task tracking and merge tracking.

#### Wave 2A.1 (shared prerequisite)
- **Added required `scope: 'stream' | 'global'` field** to `ProjectionReducer<State, Event>`. Existing reducers (`rehydration@v1`, `next-action@v1`) declared `scope: 'stream' as const`. Runtime scope-validation in Wave 3 primitives enforces correspondence.

#### Wave 3 — R-2: `decide` / `withSession` / `aggregateStream` primitives (#1314)
- **`decide<TState>(streamId, reducerId, fn, opts?)`** — pure state-machine path. Read events → fold → invoke `fn(state, ctx)` → commit via `appendComputed` with `expectedSequence: tailVersion`. Marten's `FetchForWriting<T>(streamId)` analog.
  - **Single-key-per-call idempotency** (audit §F1.3): when `operationId` supplied, derive ONE key `${streamId}:${reducerId}:${operationId}` and route all returned events through ONE `BEGIN IMMEDIATE` transaction. Crash between transactions is impossible by construction; INV-1 aggregate-as-consistency-boundary preserved.
  - **`alwaysEnforceConsistency` default `true`** — empty-events path re-reads tail and throws `ConcurrencyError` if advanced (Marten's `AlwaysEnforceConsistency` for empty-write OCC). Opt out with `alwaysEnforceConsistency: false`.
  - **Rejects global-scoped reducers** with `INVALID_REDUCER_SCOPE`.
- **`withSession<TState>(streamId, reducerId, fn, opts?)`** — imperative escape hatch. Session object exposes `aggregate`, `version`, `append(evt)`; commits queued events on `fn` resolve. Rolls back on `fn` throw. Session closes after resolve OR throw (`SESSION_CLOSED` on post-resolve `append`).
  - **Idempotency-contract gate** (audit §F1.1): rejects calls that omit BOTH `operationId` AND `allowNonIdempotent: true` — `INVALID_SESSION_OPTIONS` with `suggestedFix` pointing at `decide` or naming both opt-in flags. The runtime check prevents retry storms re-firing pivot transactions inside the closure.
  - **No in-tree consumer in this bundle.** Marten-style "available for the right shape; not the default."
- **`aggregateStream<T>(streamId, reducerId)`** — read-only fold. Returns `{aggregate, version}`. Single SELECT today (WAL gives consistent snapshot via the read transaction's end-mark). Inline note per audit §F2.3: future second-read additions MUST wrap both reads in `db.transaction(fn)`. Rejects global-scoped reducers.
- **Typed `ConcurrencyError`** with `streamId`, `reducerId`, `expectedVersion`, `actualVersion`, `operationId?`. Maps to `CONCURRENCY_CONFLICT` envelope through `wrapError()` with `validTargets: ['retry']` and `_meta.retryable: true`.
- **Typed `StorageBusyError`** (audit §F2.1) with `streamId`, `attempts`, `cause`. Maps to `STORAGE_BUSY` envelope — distinct from `CONCURRENCY_CONFLICT` because the suggested-fix shape differs (back off vs. re-fold).
- **`appendComputed` extended to accept `AppendOptions`** (`expectedSequence`) — sibling primitive change documented in Wave 3.
- **`wrapError(err, meta?, perf?)` added** as a sibling to `wrap()` — preserves `wrap()`'s strong success-only typing while exposing the typed-error → envelope mapping.

#### Wave 4 — Reference migration to two-event split (audit §F1.2)
- **`withStateRetry` recognizes `ConcurrencyError` AND `StorageBusyError`** alongside the legacy `VersionConflictError`. Predicate-based `isRetryable(err)` gate. All three trigger the same bounded exponential-backoff retry path.
- **`verbs/merge/merge-orchestrate.ts` migrated** to three-phase shape:
  1. **Phase A** (retryable): `decide` commits `merge.requested` purely. State-check short-circuit: `if state.phase === 'executed' || 'completed' return []`.
  2. **Phase B** (outside retry): `aggregateStream` re-reads state; if not already `executed`/`completed`, fire the side-effect EXACTLY ONCE.
  3. **Phase C** (retryable): `decide` commits `merge.executed` purely. Same short-circuit pattern.
- **`verbs/pure/execute-merge.ts` migrated** to the same shape — `vcsMerge` action sits in Phase B, outside any retry boundary.
- **PR-API-non-refire fixture** pins the property: forcing `ConcurrencyError` on Phase A retries the closure but the executor mock receives ZERO calls; Phase B fires it EXACTLY ONCE; Phase C retries don't re-invoke.
- **Concurrency race fixture** pins end-to-end loop: two concurrent invocations on the same feature → one wins, loser retries via `CONCURRENCY_CONFLICT` and state-check short-circuits to `[]`; final stream has exactly ONE `merge.requested` and ONE `merge.executed`; merge mock invoked exactly ONCE.
- **Storage-busy fixture** (audit §F2.1): inject substrate contention via `SqliteBusyExhaustedError` on first invocation → handler retries via `withStateRetry` → eventual success after contention clears.
- **Parity harness fixture** confirms CLI ≡ MCP `ToolResult` byte-equivalence post-migration.

#### Wave 5 — Migrate stale `action: 'set'` references to `update` (#1341)
- **92 sites migrated** to the canonical verb restored in Wave 0:
  - `servers/exarchos-mcp/src/workflow/guards.ts` — 12 `suggestedFix` payloads (closes INV-5b "suggestedFix must be actionable" violation)
  - `servers/exarchos-mcp/src/workflow/playbooks.ts` — 35 PhasePlaybook tool hints + 32 `compactGuidance` prose strings (kept consistent — same conceptual rename)
  - `commands/*.md` + `skills-src/**/*.md` — 109 occurrences across 45 files
  - 102 regenerated runtime variants under `skills/<runtime>/` (build:skills + skills:guard both pass)
- **CI grep gate** (`event-store/grep-gates.test.ts`): forbids `action: ['"]set['"]/` under `commands/`, `skills-src/`, `servers/exarchos-mcp/src/workflow/`. Exemptions documented for `*.test.ts` files (load-bearing negative tests for DR-4 hard-cut rejection) and the event-payload `data: { action: 'set' }` site (replayability for pre-rename event logs).
- **End-to-end smoke** (`__tests__/integration/ideate-update-action.test.ts`): exercises the documented ideate flow `init → update artifacts.design → transition → plan` through the dispatch core.

### Architectural posture

Adopted from Marten (see [`docs/research/2026-05-08-marten-event-store-lessons.md`](docs/research/2026-05-08-marten-event-store-lessons.md)):
- Mandatory stream-type marker (indexed) ✓
- `FetchForWriting<T>(streamId)` single-stream OCC ✓ (as `decide`)
- `AggregateStreamAsync<T>` read-only fold ✓ (as `aggregateStream`)
- `AlwaysEnforceConsistency` for empty-write OCC ✓ (default-on)
- Aggregate = stream consistency boundary ✓ (`scope: 'stream'` enforced)

Explicitly rejected per single-machine cooperative-agents framing:
- `IDocumentSession` multi-stream commit (no use case; substrate stays one-stream-per-tx)
- `FetchForExclusiveWriting` blocking lock (OCC suffices)
- Internal retry on concurrency exception (caller-controlled middleware pattern)
- Async daemon as separate process (out of scope per epic)

### Bug fix included in preview.2

- **Fixed:** `state-store.ts:applyEventToState` was missing a case for `state.patched`, so reconcile silently dropped patches that `runbooks/definitions.ts:46,88` directs callers to emit post-`set` removal. `_eventSequence` advanced but `state.artifacts` stayed null, so HSM guards reading the state file (e.g. `design-artifact-exists`, `plan-artifact-exists`) kept failing forever. Now mirrors the rehydration projection (`workflow-state-projection.ts:277-285`) and deep-merges `data.patch` into state. Surfaced during the preview.2 plan-review session itself.

### Operator notes

- **V3 → V4 schema migration is automatic** on first open of an existing exarchos.db. Pre-V4 streams without recoverable `workflowType` retain `'__legacy'` and emit one `migration.workflow_type_unknown` event each.
- **Recommend stepping through preview.1 before preview.2** so the backfill has accurate `workflowType` data in state files. (Preview.1 had no schema migration; it stabilized the substrate.)
- **No agent-facing breaking changes.** `update` is purely additive (the v2.11 removal of `set` is the breaking change covered by v2.11 release notes); the two-event split is internal to the merge handlers.

### Follow-ups parked in #1342

Thirteen items tracking the architectural leverage opportunities the preview deliberately deferred — `withSession` consumer audit, two-event split rollout to other non-idempotent handlers (`gh pr create`, `gh pr comment`, etc.), `decide` adoption beyond merge-orchestrate, in-memory store audit, snapshot cadence tuning, `merge.completed` registration vs. reducer-phase collapse, `writeStateFile` temp-filename race (production-unaffected fixture-only finding), `handleSet` idempotency-key contract (CAS retries emit extra `state.patched`), reducer-scope discipline docs, two-event split as a documented architecture pattern.

## [2.10.0-preview.1] - 2026-05-10

### Substrate stabilization (Wave α + Wave β)

- **Hardened (constructive — substrate guarantees now reach the merge path):** `merge-orchestrate` and `execute-merge` pass `idempotencyKey` + `expectedSequence` to event appends; crash-replay and concurrent-invocation scenarios no longer duplicate events (#1303). Workflow-handler emission sites migrated to canonical `buildValidatedEvent` + `appendValidated`: 10 / 18 sites covered across `workflow/cancel.ts`, `workflow/hsm-transition-guard.ts`, `workflow/rehydrate.ts`, `workflow/tools.ts`; 8 sites deferred per per-site correlation-ID abort policy (6 → α-08 follow-up, 2 → #1339 latent `state-machine` undefined-compoundStateId bug) (#1325).
- **Removed:** `AgentSpec.capabilities` runtime interface field (#1333) — derivation moves to `capabilities/resolver.ts` keyed on `posture`. `LoadTopologyOptions.emit` vestigial field (#1336 — already absent at scope time, JSDoc scrub only). Stale "Pre-v2.11" doc-comments in `storage/lifecycle.ts` and `cli-commands/subagent-context.ts` (#1335).
- **Refactored:** `prune-stale-workflows` migrated from custom multi-signal heuristic to typed-contract scorer (#1334) — pruning policy now lives in `topology.yaml` `staleness` blocks per phase, not in handler code.
- **Fixed (CI):** Three subprocess-spawning tests refactored to in-process `EventStore`, removing the `bun:sqlite` ESM scheme failure on Node CI runners (#1324). CLI-adapter coverage gap surfaced and tracked as #1337 (non-blocker).
- **Behavior improvement:** Malformed event payloads emitted via the new canonical envelope path are caught at the emission boundary (`EVENT_APPEND_FAILED`) instead of being silently persisted with `undefined` fields — surfaced by the `workflowType` integration test under `__tests__/mcp-tools.integration.test.ts`.
- **Tooling:** Shared `buildMergeOrchestrateIdempotencyKey` helper at `verbs/merge/merge-keys.ts`; shared `assertCanonicalEnvelope` test helper at `workflow/test-helpers/canonical-envelope.ts`.
- **No schema migration. No agent-surface changes. No deprecation-shim removal.** This preview is internal-only.

Operator note: upgrading from v2.10.0 main (substrate-cut tip) to v2.10.0-preview.1 is a no-op at the data layer. Stay on this preview through preview.2 — that's where the V3→V4 schema migration lands.

### v2.11 Substrate Cut (Breaking)

Closes #1327 (Tier 2 JSONL rip), #1326 (idempotency-claims bypass — subsumed), #1328 (JSONL batch_append drop — subsumed), #1322 (DR-4 / DR-6 / DR-7 deprecation-shim removals + §5 `_testOnly_` productionization + §6 substrate-stream migration), #1082 (sidecar mode obsolete). Net deletion: ~4900 LOC across 87 files.

#### Breaking — runtime substrate

- **SQLite is mandatory.** `initializeBackend` returns a `SqliteBackend` or throws. The graceful `'better-sqlite3 not available — running in JSONL-only mode'` fallback is removed. Operators on machines without a SQLite driver must install `better-sqlite3` (Node) or run under `bun` (`bun:sqlite`); the error message names both.
- **No upgrade path from v2.10 JSONL state directories.** Starting v2.11 against a state directory containing `*.events.jsonl` and no `events.db` throws with operator-actionable text ("stay on v2.10 or wipe state"). The one-shot JSONL→SQLite hydrator (`storage/hydration.ts`) is deleted; v2.10 remains available on the install URL for users who need to retain JSONL data.
- **JSONL runtime substrate removed.** `AtomicAppender.appendLocked` (the JSONL body), the `backend: 'jsonl' | 'sqlite'` discriminator, `dispatchAppend` branch, `.seq` file machinery, `rebuildCachesFromJsonl`, the JSONL idempotency cache, `replicateBackend`, `writeOutbox`, the JSONL fallbacks in `EventStore.query()` and `listStreamsMatchingPrefix`, `queryMainJsonl`, `readJsonlMaxSequence`, `readSidecarForQuery`, `getEventFilePath`, and `getSeqFilePath` are all deleted. `getReadBackend()` always returns the SqliteBackend (no `undefined` short-circuit). Resolves the Sentry blocker `r3213774862` (#1323).
- **Sidecar mode removed (#1082).** SQLite WAL handles concurrent access natively; `enterSidecarMode`, `getSidecarPath`, `EventStore.sidecarMode`, `writeSidecar`, the sidecar-merge in `query()`, `mergeByTimestamp`, and the `EventAck.sequencePending` field are all deleted. PID-lock contention now hard-throws by default (`waitForLock: true` retains retry).

#### Breaking — agent-facing contracts

- **`workflow.set({ phase })` removed (DR-4).** The v2.10 deprecation rerouting handler is deleted. Agents calling `set` with a `phase` argument now receive a structured `UNKNOWN_ACTION` error envelope listing `validActions: ['transition', ...]`. The `_meta.deprecation` schema slot is retained one more release as a historical marker (drops in v2.12); `set` no longer populates it.
- **Legacy `capabilities[]` arrays in agent specs removed (DR-6).** Specs declaring `capabilities: [...]` now fail validation with a typed error pointing to `posture` as the replacement. The `posture` field (`'read-only' | 'task-isolated' | 'shared-mutating'`) is the only authority over `yaml ⊕ handshake` capability resolution. Four in-tree `AgentSpec` definitions (`IMPLEMENTER`, `FIXER`, `REVIEWER`, `SCAFFOLDER` in `servers/exarchos-mcp/src/agents/definitions.ts`) still carry legacy arrays consumed by runtime adapters at render time — out of scope for this cut, tracked in #1333.
- **Topology phases require `staleness` blocks (DR-7).** `loadTopology()` throws on any phase missing a `staleness` declaration; the v2.10 advisory `phase.contract_missing` event-emission branch is gone. The pruner becomes a pure typed-contract scorer — the single-signal heuristic fallback is deleted. `dispatch/core/context.ts:loadTopologyIfPresent` swallows the throw so a malformed topology does not block substrate startup; `getTopology()` continues to throw "load before" until a successful load.

#### Productionized

- **`_testOnly_getSqliteBackend` → `getSqliteBackend` (DR-4 §5).** The leak-named helper is renamed; `EventStore.getReadBackend()` calls it via the public name. Verified zero `_testOnly_*` references in production code paths.

#### Operational notes

- **Forensic inspection.** Pre-v2.11 `cat *.events.jsonl` was the human-readable forensic path. Post-v2.11, use `sqlite3 events.db ".dump"` for raw inspection or `exarchos view` for typed queries.
- **Vestigial JSONL read paths removed.** `storage/lifecycle.ts` (`countJsonlLines`, `totalJsonlSizeBytes`, JSONL/seq cleanup in `compactWorkflow`, file-rotation half of `rotateTelemetry`, JSONL-byte-sum size warning in `checkCompaction`) and `cli-commands/subagent-context.ts` (`queryModuleHistory`'s JSONL scan) are deleted in this release. `queryModuleHistory` is retained as a no-op stub returning `[]` to preserve the call shape on the CLI hook hot path; SQLite-backed reimplementations of the historical-intelligence summary and the `policy.maxTotalSizeMB` threshold are tracked as v2.12 follow-ups.

#### Subsumed by construction

- **#1326 (idempotency-claims bypass).** The runtime appender's dual-write `replicateBackend → backend.appendEvent` path that bypassed `idempotency_claims` no longer exists; only the SQLite append path through `idempotency_claims` remains.
- **#1328 (JSONL `batch_append` silently drops events).** The broken JSONL `batch_append` is deleted along with all other JSONL substrate machinery.

### Features
- `preferredFacade` field on every runtime (`mcp` | `cli`) declaring the host's preferred invocation surface (cli-vs-mcp-facade-analysis, DR-1).
- Dual-facade skill rendering foundation: runtime-level declaration wired through loader and renderer (DR-1).
- CLI cold-start benchmark (`servers/exarchos-mcp/src/bench/cli-startup.bench.ts`) with separate telemetry-off (<250ms p95) and telemetry-on (<350ms p95) budgets (DR-5).
- `RemoteMcpAdapter` interface skeleton at `servers/exarchos-mcp/src/adapters/remote-mcp.ts` (DR-6, skeleton only; tracking #1081).
- Stderr `[heartbeat]` lines for `longRunning`-flagged orchestrate actions under `--json` so multi-second operations don't look like hung processes (DR-5). Flagged: `prepare_synthesis`, `assess_stack`, `check_static_analysis`, `pre_synthesis_check`, `post_delegation_check`.
- Waiting PID-lock for concurrent CLI event-store appends — two concurrent `exarchos event append` invocations now serialize onto the main JSONL (DR-5). MCP-server mode preserves first-wins + sidecar semantics so hooks never block.
- Shared parity-harness module (`servers/exarchos-mcp/src/__tests__/parity-harness.ts`) and parametrized CLI↔MCP parity tests across all five composite tools (DR-3).
- Documentation stub `docs/designs/future/remote-mcp-deployment.md` + `CLAUDE.md` Architecture pointer (DR-6 placeholder).
- `{{CALL tool action <json>}}` placeholder macro for facade-agnostic skill authoring — renders to MCP tool_use on MCP-preferred runtimes and `Bash(exarchos ...)` on CLI-preferred runtimes (cli-vs-mcp-facade-analysis, DR-2).
- Placeholder-lint deprecation warning for raw `mcp__…` references in skill sources — authors see a warning during build, CI stays green. Set `EXARCHOS_LINT_STRICT=1` to flip warnings to errors after the transition window closes (DR-2, DR-8).
- CLI rendering path with kebab-case flag mapping: `featureId: "X"` → `--feature-id X`, `dryRun: true` → `--dry-run`, trailing `--json` always appended (DR-2).
- Render-time validation of CALL macros against the `TOOL_REGISTRY` — unknown actions and invalid args fail the build with the source file path and line number (DR-2).
- Migration no-regression check (`src/build-skills.migration.test.ts`) — guards that existing Claude skill renders remain byte-identical after the dual-facade changes (DR-8).

### Breaking (wire-protocol)
- **Malformed arguments now uniformly emit `INVALID_INPUT`** from the dispatch layer (DR-5). Previously divergent across adapters: CLI hard-exited via Commander's `requiredOption`; MCP returned `UNKNOWN_ACTION` (unknown action) or surfaced downstream `EVENT_APPEND_FAILED` (wrong type, no schema validation in dispatch path). External consumers pattern-matching on the old codes for malformed-argument scenarios should switch to `INVALID_INPUT`. Handler-reported errors that pass schema validation (e.g. genuine event-append failures) continue to use their domain-specific codes.

### Removed
- **`create-exarchos` interactive installer deleted.** Prior versions vendored serena, context7, and microsoft-learn as extras installed alongside Exarchos by `npx create-exarchos`. Exarchos no longer ships or configures those MCP servers for you; install them yourself if you want them. The primary install paths are now the Claude Code plugin (`/plugin install exarchos@lvlup-sw`) and the standalone single-file binary, fetched via the bootstrap scripts at `tools/release/get-exarchos.sh` (Unix) and `tools/release/get-exarchos.ps1` (Windows). Marketplace docs have been updated to drop the stale "Integrations" table rows.

### Breaking (behavior) — Rehydration machinery refactor
- **Auto-resume hooks removed.** `SessionStart` and `PreCompact` no longer run automatically — the corresponding entries are gone from `hooks/hooks.json`, `hooks/session-start.sh` is deleted, and the `pre-compact` / `session-start` dispatch branches are removed from `adapters/hooks.ts`. The implementations (`cli-commands/session-start.ts` ~798 LoC, `cli-commands/pre-compact.ts` ~148 LoC, plus their tests and the `assemble-context.ts` helper) are deleted entirely (~5,500 LoC removed across P5).
- **Two-verb resume model.** Resume is now an explicit user action via `/exarchos:rehydrate <featureId>` (returns the canonical rehydration document — workflow state, phase playbook, recent handoffs, blockers, next actions). Checkpoints are an explicit user action via `/exarchos:checkpoint` (writes a structured handoff into the event store). Migration: anywhere docs previously said "the SessionStart hook handles X automatically", the recipe is now "run `/exarchos:rehydrate <featureId>` and read X from the returned envelope".
- **Rehydration envelope schema bumped v:2 → v:3.** `behavioralGuidance` (vestigial, never populated by any event) is dropped from the stable section; `phasePlaybook` is composed at handler time and carried in the volatile section. The v:2 read-back path still upgrades legacy snapshots in memory (see `upgrade.ts`); writers always emit v:3. `BehavioralGuidanceSchema` is no longer exported.
- **On-disk side-channel files orphaned.** The pre-compact path used to write `<featureId>.checkpoint.json` and assemble context to `<featureId>.context.md`; both behaviors are gone. Pre-existing files on disk are harmless but no longer read or written by any code path. The `commands/reload.md` slash command is also removed (its only flow was the now-deleted hook reload cycle).

## [2.6.0] - 2026-04-12

### Features
- `oneshot` workflow type with pure event-derived choice state (plan → implementing → {completed | synthesize}) (#1010)
- `prune_stale_workflows` orchestrate action for bulk pipeline hygiene (dry-run default, DI-testable safeguards, `workflow.pruned` audit event) (#1010)
- `request_synthesize` + `finalize_oneshot` orchestrate actions for oneshot choice state (#1010)
- `synthesize.requested` + `workflow.pruned` event types (#1010)
- `synthesisPolicy` optional init arg (`always` / `never` / `on-request`) for oneshot workflows, persisted in `workflow.started` event (#1010)
- `/exarchos:oneshot` and `/exarchos:prune` slash command skills with `references/` subdirectories (#1010)
- `OneshotPhaseSchema` enum for type-safe phase validation (#1010)
- Skill layer extensions threading oneshot through workflow-state, cleanup, shepherd, delegation skills (#1010)
- HSM topology introspection via `exarchos_workflow describe` with `topology` parameter (#979)
- Event emission catalog via `exarchos_event describe` with `emissionGuide` parameter (#979)
- CLI `topology [type]` and `emissions` commands for plugin-free introspection (#979)
- Cross-runtime skill rendering pipeline: single-source `skills-src/` → 6 runtime variants under `skills/<runtime>/` (Claude Code, Codex, Copilot CLI, Cursor, OpenCode, generic LCD fallback) (#1071)
- `exarchos install-skills [--agent <runtime>]` CLI with runtime auto-detection from PATH and environment variables (#1071)
- Cursor sequential-fallback mode for runtimes without an in-session subagent primitive (#1071)
- Build pipeline: `npm run build:skills` orchestrator with placeholder substitution, reference copying, override detection, and stale-source cleanup (#1071)

### Bug Fixes
- `handleList` now returns `_checkpoint` so `prune_stale_workflows` threshold filter works in production (caught by integration test; unit tests missed it due to stubbing) (#1010)
- `INITIAL_PHASE` now includes `oneshot → plan` so ES v2 rematerialized oneshot workflows start in the correct phase (#1010)
- `handlePruneStaleWorkflows` no longer double-accounts on event-append failure (caught by CodeRabbit review) (#1010)
- Removed `augmentWithSemanticScore` Phase 4 deprecation stubs and `basileusConnected` parameter plumbing from review triage (#1077)

### Hardening
- Fail-closed validation on malformed `handleList` entries (malformed entries bucketed separately, never reach `candidates` or `pruned`) (#1010)
- Input validation on `thresholdMinutes` (positive integer) and `now` (valid ISO) before batch runs (#1010)
- `oneshotPlanSet` guard tightened to require non-empty `artifacts.plan` (`planSummary` alone is insufficient, whitespace trimmed) (#1010)
- `request_synthesize` runtime phase guard rejects terminal phases (#1010)

### Internal
- `TERMINAL_PHASES` extracted to shared `workflow/terminal-phases.ts` (was duplicated) (#1010)
- `handlePruneStaleWorkflows` decomposed via `prunePruneCandidate` helper (~110 → ~60 lines) (#1010)
- New `adaptArgsWithStateDirAndEventStore` adapter in composite router for handlers needing both `stateDir` and `eventStore` (#1010)

### Documentation
- Comprehensive documentation coverage pass for v2.6.0: new oneshot-workflow guide, updated reference/learn/architecture pages
- Placeholder vocabulary reference (`docs/references/placeholder-vocabulary.md`) and runtime notes (`docs/references/runtime-notes.md`) (#1071)
- Skill authoring guide (`docs/skills-authoring.md`) covering edit workflow, vocabulary, adding runtimes, and CI checks (#1071)

### Tooling
- `npm run skills:guard` CI check — rebuilds skills in-place and fails on `git diff` to catch drift from forgotten rebuilds or direct edits to generated files (#1071)
- Per-runtime snapshot tests at `test/migration/snapshots.test.ts` — 78 baselines pinning every generated SKILL.md (#1071)
- Tier-1 runtime smoke harness at `test/smoke/runtime-smoke.test.ts` — validates per-runtime substitution correctness (Claude unconditional, others gated behind `SMOKE=1`) (#1071)

## [2.5.0] - 2026-03-09

**First public release.** Lazy schema loading, runbook protocol, typed agent specs, and a documentation site — reducing tool registration overhead by 83% while making workflows self-describing.

### Features
- Slim registration mode cutting MCP tool description payload from ~3,045 to ~500 tokens (#972)
- `describe` action on all 4 visible composite tools for on-demand schema loading (#972)
- Runbook protocol: 5 machine-readable orchestration sequences with runtime schema resolution (#972)
- Gate metadata with blocking/advisory classification and convergence dimension (#972)
- Native subagent integration: agent spec registry with `agent_spec()` MCP action and template variable interpolation (#973)
- Resume-aware fixer flow with `agentId`/`agentResumed`/`lastExitReason` on TaskSchema, `subagent-stop` hook, `TASK_FIX` runbook (#973)
- `nativeIsolation` parameter on `prepare_delegation` to skip worktree blockers for native agents (#973)
- Event type schema discovery via `describe(eventTypes)` on `exarchos_event` (#976)
- `mcpServers` allowlist on agent specs restricting subagent MCP access (#976)
- Model inheritance (`'inherit'`) replacing hardcoded `'opus'` on agent specs (#976)

### Bug Fixes
- Activate PID lock and sidecar fallback to prevent concurrent event store corruption (#971)
- Coerce stringified arrays in `fields` parameter
- Restore missing `overhaul-plan-review` transition in docs (#978)
- Add `describe` fallback to runbook annotations, clarify platform tiers
- Sync MCP server version, remove build-time agent generation
- Remove invalid `agents` field from plugin manifest

### Documentation
- VitePress documentation site with 38 pages across 5 sections (#974)
- README refresh for 2.5.0 — typed agents, runbooks, lazy schema

## [2.4.4] - 2026-03-08

### Features
- Open issues consolidation (#968, #952, #350) (#970)

### Bug Fixes
- Use gh api for backfill releases to avoid workflow scope requirement
- Fix release and project-automation workflow failures

### Documentation
- Refactor README for accuracy, add architecture section, hide sync tool

## [2.4.3] - 2026-03-07

### Bug Fixes
- Accept both error codes in concurrent init race test
- Support flexible design/plan formats in validation scripts

### CI
- Add automated release workflow and backfill script

### Chores
- Release hardening — sensitive doc removal, governance, CI guards (#969)

## [2.4.2] - 2026-03-06

### Bug Fixes
- Support flexible design/plan formats in validation scripts
- Redistribute diagram layout after flywheel removal
- Address dogfood findings, update diagram
- Restore skill description guardrails and add workflowType to brainstorming

## [2.4.0] - 2026-03-04

### Features
- Schema-driven CLI surface with config-driven custom workflows (#963)
- New local skills for project-level customization
- README updates and VHS terminal recordings

### Bug Fixes
- Unified binary with explicit `mcp` subcommand
- Integrate hook CLI commands into unified binary

### Refactoring
- Remove project-specific sync-schemas skill
- Reduce plugin token footprint by 57%

### Chores
- Prune plugins and claude/memory files

## [2.3.8] - 2026-03-02

### Features
- Add visual assets for GA release

### Bug Fixes
- Update subagent-context test counts for 5 new orchestrate actions, overhaul README
- Add direct-push completion path for debug hotfixes and tag universal transitions (#957, #958)

### Documentation
- Refresh community-facing README references
- Revise visual asset specs for GA release

## [2.3.7] - 2026-03-02

### Bug Fixes
- Add 5 missing orchestrate actions to registry, add sync test

## [2.3.6] - 2026-03-02

### Features
- Add event emission source registry and boundary data validation (#955)

### Bug Fixes
- Remove stale @planned annotation from team.disbanded (#954)

## [2.3.5] - 2026-03-02

### Bug Fixes
- Remove deprecated `/resume` command, replace with `/rehydrate`

## [2.3.4] - 2026-03-02

### Bug Fixes
- Array-of-objects upsert in deepMerge, harden gate check and review projection

## [2.3.3] - 2026-03-02

### Bug Fixes
- Align phase names with HSM definitions, add phase-name validation

## [2.3.2] - 2026-03-02

### Bug Fixes
- Sync plugin manifest versions to 2.3.1, add version:sync to rebuild
- Sync backend version counter with state._version on seed (#948)

## [2.3.1] - 2026-03-01

### Refactoring
- Namespace all skill references with `exarchos:` prefix

## [2.3.0] - 2026-03-01

### Bug Fixes
- Sequence corruption auto-repair, guard diagnostics, shepherd DX (#947)

### Refactoring
- Make plugin self-contained for marketplace install (#946)

## [2.2.2] - 2026-03-01

### Bug Fixes
- Expand tilde in WORKFLOW_STATE_DIR, remove stale artifacts
- Stale .seq cross-validation, manual evidence gate bypass, completed status alias (#939, #940, #941)

### Documentation
- README restructure, metadata refresh, and copy cleanup

## [2.2.1] - 2026-03-01

### Bug Fixes
- Audit remediation — bound arrays, extract skill body, add overhaul-plan-review (#938)

## [2.2.0] - 2026-03-01

### Features
- Event-driven skill architecture with CQRS readiness projections (#930)
- Add judge calibration pipeline and gold standard dataset
- Activate verification flywheel — remediation events and quality hints
- Add eval-backed feature audit prompt and regression dataset

### Bug Fixes
- Address review feedback and eval regression check (#932)
- Detect default branch dynamically in prepare-synthesis (#934)

### Refactoring
- Remove Graphite integration, adopt GitHub-native PR stacking (#933)
- Consolidate gate-telemetry integration, enforce D2, harden execFileSync

## [2.1.2] - 2026-02-28

### Bug Fixes
- Recognize deferred sections in plan coverage verification (#913) (#927)

## [2.1.1] - 2026-02-27

This was a large release spanning the v2.1.0 milestone, covering session provenance, phase playbooks, verification flywheel closure, and eval framework expansion.

### Features
- Add session provenance — event hardening, types, manifest, transcript parser, lifecycle (#896)
- Add session provenance query layer — projection, view integration (#903)
- Close verification flywheel loop — calibration, capture, signal wiring, integration (#914)
- Add phase playbook module with all workflow entries (#846)
- Add behavioral guidance section to context assembly (#856)
- Add behavioralGuidance field to SessionStartResult (#858)
- Add playbook virtual field to exarchos_workflow get (#860)
- Add `/rehydrate` command and deprecate `/resume` (#861)
- Add `/tag` command and document opt-in tracking philosophy
- Add validate-phase-coverage.sh meta-validation script (#852)
- Wire 4 validation scripts into skills (#845)
- Add compaction-behavioral eval dataset and update reliability suite (#849)
- Add cache hit/miss tracking and thrashing detection to ViewMaterializer (#917)
- Split Zod validation from event construction for hot-path optimization (#918)
- Enforce PR description template with CI validation and configurable overrides (#907) (#909)
- Add write-through .state.json backup and preserve files during migration (#806) (#906)
- Add LLM rubric assertion and dataset to brainstorming eval suite (#792)
- Add quality-aware dataset and llm-similarity assertion to delegation eval suite (#797)
- Add LLM rubric assertion and dataset to implementation-planning eval suite (#795)
- Add LLM rubric assertion and dataset to debug eval suite (#796)
- Add quality_correlation view joining CodeQuality and EvalResults by skill (#800)
- Remove stale @planned annotations and add shepherd event schemas (#781)

### Bug Fixes
- Add iteration limits, spec re-verification, and data handoff protocol to skills (#919)
- Extract gate event emission and add debug/refactor disambiguation (#920)
- Harden PR validation script and CI workflow (#911)
- Update SERVER_VERSION constant and test expectations to 1.1.0 (#912)
- Add max-length constraints to unbounded event payload fields (#916)
- Update pre-synthesis-check.sh for polish track and debug HSM phases (#851)
- Update reconcile-state.sh valid phases to match HSM (#850)
- Update refactor eval datasets to use correct HSM phase names (#848)
- Await async property test, validate stateFile paths, fix checkpoint loop break (#863)
- Populate _events for guard evaluation and skip team guard in subagent mode (#788)

### Refactoring
- Harden event store idempotency and sequence invariants (#822)
- Add HSM transitions for escalation, revision limits, and hotfix (#823)
- Add schema safety constraints and synthesize retry (#824)
- Clean up content layer documentation and scripts (#825)
- Add benchmark infrastructure and always-on CI gate (#826)

### Tests
- Add HSM-playbook coverage and content adequacy property tests (#847)
- Add discovery and parse tests for new eval suites (#785)

## [2.0.8] - 2026-02-23

### Bug Fixes
- Use INSERT OR IGNORE for event hydration to handle duplicate sequences

## [2.0.7] - 2026-02-23

### Features
- Complete eval framework Phase 3 (#773)
- Foundation cleanup and orphan event wiring (#774)
- Add eval suites for brainstorming, planning, refactor, and debug skills (#784)
- Add LLM rubric assertion and dataset to debug eval suite (#796)
- Add LLM rubric assertion and dataset to refactor eval suite (#794)
- Wire regression detector into code quality view + add quality-check CLI (#798)
- Add gate.executed event emission instructions to shepherd, synthesis, and delegation skills (#793)

### Bug Fixes
- Prevent property collision in captureTrace spread ordering
- Initialize explore field in state to prevent guard rejection (#775) (#779)
- Hydrate _events from event store before guard evaluation
- Bundle better-sqlite3 native binary + fix versionless state migration
- Update rebuild

### Refactoring
- Use typed TeamTaskAssignedData schema in CQRS view (#780)

### Tests
- Add E2E round-trip and crash recovery tests for storage layer
- Add lifecycle SQLite + hydration PBT tests
- Add storage E2E validation suite (#772)

### CI
- Switch all workflows to self-hosted runners
- Install gh CLI on self-hosted runners for review gate and project automation

---

## Legacy Changelog (pre-semver)

## 2026-02-09

### Removed Jules MCP Integration

Jules (Google's autonomous coding agent) integration has been removed. It was never used in production and is superseded by the Task tool subagent pattern.

**Removed:**
- `plugins/jules/` — entire MCP server and plugin directory
- `julesSessions` field from workflow state schema and initial state
- `julesSessionId` and `jules` assignee from JSON schema
- Jules permissions, labels, and auto-triage scope detection
- Jules references from delegation skill, delegate command, and documentation

## 2026-01-06

### Workflow Phase Restructuring

Added explicit integration phase and orchestrator constraints:

**New `/integrate` Phase:**
- Merges worktree branches in dependency order
- Runs combined test suite after each merge
- Reports pass/fail with specific failure details
- Auto-chains to `/review` on success, `/delegate --fixes` on failure

**Orchestrator Constraints:**
- Orchestrator no longer writes implementation code
- All fixes delegated to subagents (fixer prompt template)
- Worktree enforcement prevents accidental main project modifications

**Review Updates:**
- Reviews now assess integrated diff (not per-worktree fragments)
- Full picture of combined code quality

**Synthesis Simplification:**
- Merge/test logic moved to `/integrate`
- `/synthesize` now just creates PR from integration branch

**Updated flow:**
```
/ideate -> [CONFIRM] -> /plan -> /delegate -> /integrate -> /review -> /synthesize -> [CONFIRM] -> merge
            ^           (auto)   (auto)      (auto)      (auto)     (auto)           ^
          HUMAN                                                                    HUMAN
                                   ^                        |
                                   +---- --fixes -----------+
```

**Files added:**
- `rules/orchestrator-constraints.md`
- `skills/integration/SKILL.md`
- `skills/integration/references/integrator-prompt.md`
- `skills/delegation/references/fixer-prompt.md`
- 14 test scripts

**Files modified:**
- `skills/delegation/SKILL.md` (worktree enforcement + fix mode)
- `skills/spec-review/SKILL.md`, `skills/quality-review/SKILL.md` (integrated diff)
- `skills/synthesis/SKILL.md` (simplified)
- `docs/schemas/workflow-state.schema.json` (integration object)

---

## 2026-01-04

### PR Feedback Loop & Direct Commits

Added support for human interaction with PRs:

**PR Review Feedback:**
- New `--pr-fixes` flag for `/delegate`
- Fetches PR comments via `gh api`
- Creates fix tasks from review feedback
- Loops back to merge confirmation after fixes

**Direct Commits:**
- Users can commit directly to integration branch
- Workflow syncs (`git pull`) before merge confirmation
- Documented in synthesize command and skill

**Updated flow:**
```
/ideate -> [CONFIRM] -> /plan -> /delegate -> /integrate -> /review -> /synthesize -> [CONFIRM] -> merge
                                            ^                                       |
                                            +----------- --pr-fixes ----------------+
```

---

### Streamlined Auto-Chain Flow

Reduced confirmation prompts in the workflow pipeline:

**New flow:**
```
/ideate -> [CONFIRM] -> /plan -> /delegate -> /integrate -> /review -> /synthesize -> [CONFIRM] -> merge
            ^           (auto)   (auto)      (auto)      (auto)     (auto)           |
            +------------ ON BLOCKED ------------------------------------------------+
                          ON FAIL -> /delegate --fixes (auto)
```

**Changes:**
- `/plan` -> `/delegate`: Now auto-invokes (no confirmation)
- `/delegate` -> `/review`: Now auto-invokes (no confirmation)
- `/review` -> `/synthesize`: Now auto-invokes on PASS (no confirmation)
- `/synthesize` -> merge: Added confirmation before merging PR
- `/review`: Now dispatches to subagents (preserves orchestrator context)

**Files modified:**
- `commands/plan.md`, `commands/delegate.md`, `commands/review.md`, `commands/synthesize.md`
- `skills/spec-review/SKILL.md`, `skills/quality-review/SKILL.md`
- `skills/implementation-planning/SKILL.md`, `skills/delegation/SKILL.md`

---

### Initial Global Configuration

- **Skills (7)**: brainstorming, implementation-planning, git-worktrees, delegation, spec-review, quality-review, synthesis
- **Commands (6)**: ideate, plan, delegate, review, synthesize, tdd
- **Rules (4)**: tdd-typescript, tdd-csharp, coding-standards-csharp, coding-standards-typescript
- **Plugins (1)**: jules (symlinked from workflow/jules-plugin)
- **Settings**: Global permissions for WebSearch, Jules API, GitHub

### Update Policy

Before updating global config:
1. Test changes locally in a project first
2. Validate with `/review` quality checks
3. Document changes in this file
4. Project-level `.claude/` overrides take precedence
