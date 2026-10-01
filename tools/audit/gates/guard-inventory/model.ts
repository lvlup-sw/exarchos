import type { FilenameCoupledEntrypoint } from './artifact-predicates.js';
import type { ShellIndirectionIndex } from './hosts.js';

export type { FilenameCoupledEntrypoint } from './artifact-predicates.js';

export type GuardChannel = 'enforcer-manifest' | 'wave1-spec' | 'mcp-scripts-gate' | 'conformance-suite';

/**
 * How a CI job reaches a guard.
 *
 * `'direct'`    — a step executes the guard's own entrypoint (npm chains expanded).
 * `'self-test'` — a step runs the guard's co-located test, either as a vitest
 *                 suite member or as a named `.test.sh` re-assert.
 *
 * A self-test can assert the current state and not the policy, so a hosted
 * self-test does not prove a wired gate. See {@link isEnforcingHost}.
 */
export type HostingVia = 'direct' | 'self-test';

export type Enforcement = 'blocks' | 'observes' | 'unreachable';

export interface GuardHost {
  /** Repo-relative workflow path. */
  readonly workflow: string;
  readonly job: string;
  readonly via: HostingVia;
  /**
   * The wrapper-script chain between the run-step and the guard, outermost first.
   * Empty for a step that names the guard itself.
   * The chain states how the guard is reachable, so a reviewer can check the claim.
   */
  readonly through: readonly string[];
  /** `changes.outputs.*` keys that gate the job. An empty list means unfiltered. */
  readonly pathFilterKeys: readonly string[];
  /** True when the step (or job) swallows the exit code. */
  readonly exitSwallowed: boolean;
  /**
   * True when the host workflow declares a `pull_request` trigger. A host that
   * only runs on a tag push is a real execution site, but not pre-merge coverage.
   */
  readonly onPullRequest: boolean;
  /** True when a failure of this job can fail the PR, as far as YAML can say. */
  readonly blocking: boolean;
}

/**
 * Which hosts enforce the policy of a guard, and do not only run its unit tests.
 * A runnable guard (a shell script, or a module with a `process.exit` entrypoint) states its verdict by its exit code, so only a step that executes it enforces anything.
 * A non-runnable source module has no entrypoint, so its co-located vitest is the enforcement path.
 */
export function isEnforcingHost(host: GuardHost, runnable: boolean): boolean {
  return runnable ? host.via === 'direct' : true;
}

export interface GuardRecord {
  /** Repo-relative, forward-slashed path of the guard artifact. */
  readonly artifact: string;
  /** Every channel that discovered it — more than one is normal and good. */
  readonly channels: readonly GuardChannel[];
  /** Wave-1 task ids that name this artifact, when channel 2 saw it. */
  readonly wave1Tasks: readonly string[];
  readonly hosts: readonly GuardHost[];
  /** True when the guard states its verdict by exiting — see {@link isEnforcingHost}. */
  readonly runnable: boolean;
  readonly enforcement: Enforcement;
  /**
   * True when each enforcing host is path-filtered. A gate in a path-filtered job
   * is skipped-as-passed on the PRs that it polices.
   */
  readonly pathFilteredOnly: boolean;
  /**
   * True when a non-test module imports a named binding from this artifact.
   * `false` means that the mechanism ships and nothing calls it. CI can still execute the guard through its co-located vitest.
   * `null` when the artifact is not a TypeScript module, so the question does not apply.
   */
  readonly productionImported: boolean | null;
}

export interface GuardInventory {
  readonly guards: readonly GuardRecord[];
  /**
   * Runnable modules under {@link MCP_SCRIPTS_DIR} with no co-located self-test.
   * The guard population excludes them, because a guard needs a self-test in its own CI job.
   * The list keeps that exclusion reviewable.
   */
  readonly runnableWithoutSelfTest: readonly string[];
  /**
   * Modules under {@link GUARD_SUITE_ROOTS} with no co-located self-test, such as data tables, CLI entrypoints and composition-root bindings.
   * The list keeps the population boundary reviewable, and a census that loses its self-test appears here.
   */
  readonly suiteModulesWithoutSelfTest: readonly string[];
  /**
   * Wave-1 source artifacts with no co-located self-test and no runnable entrypoint.
   * Their enforcement is at compile time (`tsc --noEmit`), so execution reachability does not apply to them.
   * A guard that loses its self-test lands here.
   */
  readonly compileTimeOnlyArtifacts: readonly string[];
  /**
   * Path-shaped `**Files:**` entries of Wave-1 tasks that do not resolve on disk.
   * A drift signal (renamed or not-yet-landed), reported not failed — Wave-1
   * tasks legitimately name files their own task has not landed yet.
   */
  readonly unresolvedSpecArtifacts: readonly string[];
  /**
   * Guards whose self-execution is decided by their own FILENAME.
   *
   * A rename plus the matching `run:` edit turns such a guard into a step that
   * enforces nothing. The other columns of the inventory still report it as
   * direct, unfiltered and blocking.
   */
  readonly filenameCoupledEntrypoints: readonly FilenameCoupledEntrypoint[];
  /**
   * How many artifacts the entrypoint-predicate classifier actually parsed.
   *
   * The non-empty-denominator rule applied to the check itself: a classifier
   * that examined nothing reports zero coupled entrypoints and is
   * indistinguishable from a clean tree.
   */
  readonly entrypointPredicatesScanned: number;
  /**
   * What the wrapper-script walk examined. A walk of zero run-steps or zero wrappers
   * reports each indirectly hosted guard as unwired, so the inventory checks these counts too.
   */
  readonly indirection: ShellIndirectionIndex;
}
