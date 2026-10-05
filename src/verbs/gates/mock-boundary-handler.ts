/**
 * The `check_mock_boundary` orchestrate action. It runs the mock-boundary gate on the diff of a
 * task and persists subject-bound evidence. The pure core `mock-boundary.ts` does the detection.
 * This handler resolves the repo root, parses the `baseRef...HEAD` diff, reads the
 * `ownership.firstParty` globs, resolves the gate severity, and persists the evidence.
 *
 * The result is an advisory carrier: `success: true`, with `data.passed` as the verdict. An
 * unowned mock is a finding, not a tool error.
 *
 * A non-empty `reason` acknowledges an intentional unowned mock. The gate then passes at each
 * severity, and the evidence records the acknowledgement. The findings stay in the result.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { defaultGitExec, resolvePolicySkip, SKIPPED_BY_POLICY } from './gate-utils.js';
import { runGatePreflight } from '../pure/gate-preflight.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import type { RiskTier } from '../../workflow/verification-policy.js';
import { resolveGateSeverity } from './gate-severity.js';
import { DEFAULTS, resolveConfig, type ResolvedProjectConfig } from '../../config/resolve.js';
import { loadExarchosConfig, type LoadResult } from '../../config/load-exarchos-config.js';
import type { GitExec } from '../pure/execute-merge.js';
import {
  detectMockFindings,
  type FileDiff,
  type AddedLine,
  type MockFinding,
} from './mock-boundary.js';
import {
  classifyHermeticDependency,
  resolveHermeticDouble,
} from '../../config/toolchains.js';

/**
 * Builds the next-action steer for an unowned mock. The steer names what to do, not only what is
 * wrong. A dependency in a known class gets its concrete hermetic double, with its fidelity,
 * cadence, and caveat. An unclassified dependency gets the generic menu.
 */
export function steerForFinding(finding: MockFinding): string {
  const depClass = classifyHermeticDependency(finding.mockedTarget);
  if (depClass !== null) {
    const d = resolveHermeticDouble(depClass);
    return (
      `replace the mock of \`${finding.mockedTarget}\` (${depClass}) with ` +
      `${d.double} [fidelity: ${d.fidelity}; cadence: ${d.cadence}]` +
      (d.caveat ? ` — ${d.caveat}` : '') +
      ` — mocking an unowned dependency asserts against a fiction (the mock ` +
      `cannot be checked against the real contract)`
    );
  }
  return (
    `replace the mock of \`${finding.mockedTarget}\` with a hermetic fixture / ` +
    `contract-verified stub / a fake — mocking an unowned dependency asserts ` +
    `against a fiction (the mock cannot be checked against the real contract)`
  );
}

export interface MockBoundaryHandlerArgs {
  readonly featureId: string;
  readonly taskId: string;
  /** The task branch (HEAD side of the diff). Defaults to the current branch. */
  readonly branch?: string;
  /** Base ref the branch diverged from (merge-base target). Defaults to 'main'. */
  readonly baseBranch?: string;
  /**
   * Repo to check. The handler uses a literal path as is. `'auto'` resolves the agent worktree of
   * the calling delegation. Without a value, the handler uses `process.cwd()`.
   */
  readonly repoRoot?: string;
  /** Explicit agent worktree path — preferred resolver seam for 'auto'. */
  readonly worktreePath?: string;
  /** Legacy field. Evidence idempotency uses only the trusted DispatchContext. */
  readonly operationId?: string;
  /**
   * Escape hatch: a reason that acknowledges an intentional unowned mock. When it is non-empty,
   * the gate passes at each severity and durable evidence records the acknowledgement.
   */
  readonly reason?: string;
  /**
   * The stamped risk tier of the task. With {@link boundaryTouching} also present, the handler
   * skips itself when the resolved verification sequence omits this gate. Without both stamps,
   * the gate runs.
   */
  readonly riskTier?: RiskTier;
  /** The task's stamped boundary-touching flag. See {@link riskTier}. */
  readonly boundaryTouching?: boolean;
  /**
   * The resolved project config from the dispatch adapter. The self-skip routing thus uses the
   * same policy sequence as the delegation stamp. Without it, the resolver uses the built-in
   * table. {@link loadConfig} is separate and reads the per-worktree globs and severity.
   */
  readonly projectConfig?: ResolvedProjectConfig;
  /** Test seam. Defaults to `defaultGitExec`. */
  readonly gitExec?: GitExec;
  /** Config loader for ownership globs + review-gate severity. */
  readonly loadConfig?: (worktreePath: string) => LoadResult | null;
}

const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses a unified `git diff baseRef...HEAD` into {@link FileDiff} entries, one per changed file.
 * Each entry holds only the added lines, with their post-image line numbers. A mock that the diff
 * deletes is thus never flagged.
 *
 * The post-image cursor starts at each hunk header and advances on added and context lines. For a
 * rename, the entry uses the `b/` path.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let currentPath: string | undefined;
  let currentAdded: AddedLine[] = [];
  let newLine = 0;

  const flush = (): void => {
    if (currentPath !== undefined) {
      files.push({ path: currentPath, addedLines: currentAdded });
    }
  };

  for (const raw of diff.split('\n')) {
    const fileMatch = raw.match(DIFF_GIT_RE);
    if (fileMatch) {
      flush();
      currentPath = fileMatch[2];
      currentAdded = [];
      newLine = 0;
      continue;
    }
    if (currentPath === undefined) {
      continue;
    }
    const hunkMatch = raw.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      newLine = Number.parseInt(hunkMatch[1] ?? '0', 10);
      continue;
    }
    if (raw.startsWith('+')) {
      if (raw.startsWith('+++')) continue;
      currentAdded.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      if (raw.startsWith('---')) continue;
      continue;
    }
    if (raw.startsWith('\\')) {
      continue;
    }
    if (newLine > 0) newLine += 1;
  }
  flush();
  return files;
}

/**
 * Runs the mock-boundary gate for one task.
 *
 * A missing or malformed `.exarchos.yml` falls back to the default globs and severity, and never
 * fails the gate. The diff uses `--no-ext-diff`, because a `diff.external` wrapper replaces the
 * unified diff and gives zero findings. A git failure gives zero findings.
 *
 * The gate fails only when the severity is blocking, an unowned mock exists, and no `reason` is
 * given. The built-in severity is `warning`, so only a project override makes the gate block.
 * Steers appear only when findings exist and no `reason` is given.
 */
export async function handleMockBoundary(
  args: MockBoundaryHandlerArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const pre = await runGatePreflight(
    {
      featureId: args.featureId,
      taskId: args.taskId,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      handlerName: 'handleMockBoundary',
      requireTaskId: true,
    },
    eventStore,
  );
  if (!pre.ok) return pre.result;
  const repoRoot = pre.repoRoot;
  const baseRef = args.baseBranch || 'main';

  return runDurableGateProducer(
    {
      gateClass: 'mock-boundary',
      featureId: args.featureId,
      taskId: args.taskId,
      ...(args.branch ? { branch: args.branch } : {}),
      baseRef,
      repoRoot,
      stateDir,
      eventStore,
    },
    async () => {
      const policySkip = resolvePolicySkip({
        gateName: 'check_mock_boundary',
        riskTier: args.riskTier,
        boundaryTouching: args.boundaryTouching,
        config: args.projectConfig,
      });
      if (policySkip) {
        return {
          success: true,
          data: {
            passed: true,
            skipped: true,
            findings: [],
            report: policySkip.reason,
            discriminant: SKIPPED_BY_POLICY,
          },
        };
      }

      const gitExec = args.gitExec ?? defaultGitExec;
      const loadConfig = args.loadConfig ?? loadExarchosConfig;

      let firstPartyGlobs: readonly string[] = DEFAULT_FIRST_PARTY_GLOBS;
      let resolvedConfig: ResolvedProjectConfig | undefined;
      try {
        const loaded = loadConfig(repoRoot);
        if (loaded?.config.ownership?.firstParty) {
          firstPartyGlobs = loaded.config.ownership.firstParty;
        }
        if (loaded?.config) {
          resolvedConfig = resolveConfig(loaded.config);
        }
      } catch {
      }

      const severity = resolveGateSeverity('mock-boundary', 'D1', resolvedConfig ?? DEFAULTS);

      const diffResult = gitExec(repoRoot, ['diff', '--no-ext-diff', `${baseRef}...HEAD`]);
      const fileDiffs = diffResult.exitCode === 0 ? parseUnifiedDiff(diffResult.stdout) : [];
      const findings = detectMockFindings(fileDiffs, { firstPartyGlobs });

      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      const escapeHatch = reason.length > 0 ? { acknowledged: true, reason } : undefined;

      const hasFindings = findings.length > 0;
      const passed = !hasFindings || escapeHatch !== undefined || severity !== 'blocking';

      const nextActions =
        hasFindings && escapeHatch === undefined ? findings.map(steerForFinding) : [];

      return {
        success: true,
        data: {
          passed,
          findings,
          severity,
          ...(escapeHatch ? { escapeHatch } : {}),
          ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
        },
      };
    },
  );
}

/**
 * A copy of the `ownership.firstParty` schema default, so the handler uses the same scope when no
 * `.exarchos.yml` exists. Keep it in sync with `exarchos-config-schema.ts`.
 */
const DEFAULT_FIRST_PARTY_GLOBS: readonly string[] = ['src/**', 'servers/*/src/**'];
