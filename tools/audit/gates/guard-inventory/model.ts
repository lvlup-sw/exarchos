import type { ShellIndirectionIndex } from './hosts.js';

export type GuardChannel = 'enforcer-manifest' | 'wave1-spec' | 'mcp-scripts-gate' | 'conformance-suite';

/**
 * How a CI job reaches a guard.
 *
 * `'direct'`    — a step executes the guard's own entrypoint (npm chains expanded).
 * `'self-test'` — a step runs the guard's co-located test, either as a vitest
 *                 suite member or as a named `.test.sh` re-assert.
 *
 * The distinction is load-bearing and was learned the hard way on this very
 * inventory. `cli-derivation-guard`'s co-located test runs on every MCP-touching
 * PR — and asserts the CURRENT literal count (11), not the POLICY (zero). Its
 * self-test is hosted; its gate is not. Treating "the self-test runs" as "the
 * guard is wired" would have reported the single guard this task exists to find
 * as green. See {@link isEnforcingHost}.
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
   *
   * Carrying the chain rather than a boolean is the difference between a verdict
   * that says "reachable" and one that says HOW: `knip-diff.ts` is reachable
   * because `validate-no-legacy` runs `tools/audit/gates/validate-no-legacy.sh`, and that
   * sentence is the reviewable claim. A bare "reachable" cannot be checked.
   */
  readonly through: readonly string[];
  /** `changes.outputs.*` keys gating the job; empty means unfiltered. */
  readonly pathFilterKeys: readonly string[];
  /** True when the step (or job) swallows the exit code. */
  readonly exitSwallowed: boolean;
  /**
   * True when the host workflow declares a `pull_request` trigger. A host that
   * only fires on a tag push (`release.yml` runs the whole root suite) is a real
   * execution site but is NOT pre-merge coverage, so it must not stand in for one.
   */
  readonly onPullRequest: boolean;
  /** True when a failure of this job can fail the PR, as far as YAML can say. */
  readonly blocking: boolean;
}

/**
 * Which hosts actually enforce a guard's POLICY, as opposed to merely running
 * its unit tests.
 *
 * A RUNNABLE guard (one with its own `process.exit` entrypoint, or a shell
 * script) states its verdict by exiting non-zero, so only a step that EXECUTES
 * it enforces anything. A non-runnable source module has no entrypoint — its
 * co-located vitest IS the enforcement path, which is exactly how the
 * `auditVacuity*` family and the authority census are enforced today.
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
   * True when every ENFORCING host is path-filtered. #1711's skipped-as-passed
   * failure is the reason this field exists: a gate in a path-filtered job is
   * skipped-as-passed on exactly the PRs it polices.
   */
  readonly pathFilteredOnly: boolean;
  /**
   * True when some NON-test module imports a named binding from this artifact.
   * `false` is the R-11 signal — "the mechanism ships and nothing calls it" —
   * and is orthogonal to CI reachability: a guard can be executed by CI (through
   * its co-located vitest) while having no production caller at all.
   * `null` when the artifact is not a TypeScript module, so the question does
   * not apply and cannot be silently answered "yes".
   */
  readonly productionImported: boolean | null;
}

export interface GuardInventory {
  readonly guards: readonly GuardRecord[];
  /**
   * Runnable modules under {@link MCP_SCRIPTS_DIR} with NO co-located self-test.
   * Excluded from the guard population by DR-24's own definition ("each guard's
   * self-test runs in the same CI job as the guard"), and listed so that
   * exclusion is reviewable rather than silent.
   */
  readonly runnableWithoutSelfTest: readonly string[];
  /**
   * Modules under {@link GUARD_SUITE_ROOTS} with no co-located self-test — the
   * data tables, CLI entrypoints and composition-root bindings a suite carries
   * alongside its censuses. Channel 4's counterpart to
   * {@link GuardInventory.runnableWithoutSelfTest}: listed so the population's
   * boundary is reviewable, and so a census that LOSES its self-test surfaces
   * here instead of vanishing from the inventory.
   */
  readonly suiteModulesWithoutSelfTest: readonly string[];
  /**
   * Wave-1 source artifacts with no co-located self-test and no runnable
   * entrypoint — modules whose enforcement rung is COMPILE TIME (`tsc --noEmit`
   * in the typecheck steps), e.g. `output-schema-declaration.ts` and
   * `contract/sdk/brand.ts`. They carry no executable verdict, so execution-reachability
   * is not a question that can be asked of them. Reported, never silently
   * dropped: a guard that loses its self-test would land here rather than
   * disappearing.
   */
  readonly compileTimeOnlyArtifacts: readonly string[];
  /**
   * Path-shaped `**Files:**` entries of Wave-1 tasks that do not resolve on disk.
   * A drift signal (renamed or not-yet-landed), reported not failed — Wave-1
   * tasks legitimately name files their own task has not landed yet.
   */
  readonly unresolvedSpecArtifacts: readonly string[];
  /**
   * What the wrapper-script walk actually examined. Present so the indirection
   * resolver is subject to the same non-empty-denominator rule as the inventory:
   * a resolver that walked zero run-steps or zero wrappers would silently report
   * every indirectly-hosted guard as unwired, which is the failure task 070 was
   * dispatched to fix — reintroduced quietly.
   */
  readonly indirection: ShellIndirectionIndex;
}

// ─── Channel 1: enforcer-manifest primaries ──────────────────────────────────
