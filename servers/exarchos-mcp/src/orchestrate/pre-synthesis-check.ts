// ─── Pre-Synthesis Readiness Check Handler ──────────────────────────────────
//
// Validates all readiness conditions before synthesis phase. Ports the logic
// from scripts/pre-synthesis-check.sh into a TypeScript handler with 7 checks:
//   1. State file exists and is valid JSON
//   2. Phase readiness (workflow-type-specific transition paths)
//   3. All tasks complete
//   4. Reviews passed (flat, nested, legacy shapes)
//   5. No outstanding fix requests
//   6. PR stack exists (skippable)
//   7. Tests pass (skippable)
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import { detectTestCommands } from './detect-test-commands.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PreSynthesisCheckArgs {
  readonly stateFile: string;
  readonly repoRoot?: string;
  readonly skipTests?: boolean;
  readonly skipStack?: boolean;
  readonly testCommand?: string;
}

interface CheckCounters {
  pass: number;
  fail: number;
  skip: number;
}

interface CheckContext {
  readonly results: string[];
  readonly counters: CheckCounters;
}

// ─── Passing status patterns ────────────────────────────────────────────────

const PASSING_STATUS = /^(pass|passed|approved)$/;

// ─── Check helpers ──────────────────────────────────────────────────────────

function checkPass(ctx: CheckContext, name: string): void {
  ctx.results.push(`- **PASS**: ${name}`);
  ctx.counters.pass++;
}

function checkFail(ctx: CheckContext, name: string, detail?: string): void {
  const suffix = detail ? ` — ${detail}` : '';
  ctx.results.push(`- **FAIL**: ${name}${suffix}`);
  ctx.counters.fail++;
}

function checkSkip(ctx: CheckContext, name: string): void {
  ctx.results.push(`- **SKIP**: ${name}`);
  ctx.counters.skip++;
}

// ─── Check 1: State file exists and is valid JSON ───────────────────────────

function checkStateFile(
  ctx: CheckContext,
  stateFile: string,
): Record<string, unknown> | null {
  if (!existsSync(stateFile)) {
    checkFail(ctx, 'State file exists', `File not found: ${stateFile}`);
    return null;
  }

  try {
    const raw = readFileSync(stateFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      checkFail(ctx, 'State file exists', `Invalid JSON: expected top-level object in ${stateFile}`);
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    // Validate expected field shapes before downstream checks consume them
    if ('tasks' in obj && !Array.isArray(obj['tasks'])) {
      checkFail(ctx, 'State file exists', `Invalid state shape: "tasks" must be an array in ${stateFile}`);
      return null;
    }

    if ('reviews' in obj) {
      const reviews = obj['reviews'];
      if (typeof reviews !== 'object' || reviews === null || Array.isArray(reviews)) {
        checkFail(ctx, 'State file exists', `Invalid state shape: "reviews" must be an object in ${stateFile}`);
        return null;
      }
    }

    checkPass(ctx, 'State file exists');
    return obj;
  } catch {
    checkFail(ctx, 'State file exists', `Invalid JSON: ${stateFile}`);
    return null;
  }
}

// ─── Check 2: Phase readiness ───────────────────────────────────────────────

function checkPhaseReadiness(
  ctx: CheckContext,
  state: Record<string, unknown>,
): void {
  const phase = (state['phase'] as string | undefined) ?? 'unknown';
  const workflowType = (state['workflowType'] as string | undefined) ?? 'feature';

  if (phase === 'synthesize') {
    checkPass(ctx, 'Phase is synthesize');
    return;
  }

  const missing: string[] = [];

  switch (workflowType) {
    case 'feature':
      switch (phase) {
        case 'review':
          missing.push('Transition: review → synthesize (guard: allReviewsPassed)');
          break;
        default:
          checkFail(
            ctx,
            'Phase is synthesize',
            `Current phase '${phase}' — manual phase advancement needed for ${workflowType} workflow`,
          );
          return;
      }
      break;

    case 'refactor':
      switch (phase) {
        case 'polish-implement':
        case 'polish-validate':
        case 'polish-update-docs':
          checkFail(
            ctx,
            'Phase is synthesize',
            `Current phase '${phase}' — polish track completes directly (no synthesize). Use exarchos_workflow cleanup.`,
          );
          return;

        case 'overhaul-plan':
          missing.push('Transition: overhaul-plan → overhaul-plan-review (guard: planArtifactExists)');
          missing.push('Transition: overhaul-plan-review → overhaul-delegate (guard: planReviewComplete)');
          missing.push('Transition: overhaul-delegate → overhaul-review (guard: allTasksComplete)');
          missing.push('Transition: overhaul-review → overhaul-update-docs (guard: allReviewsPassed)');
          missing.push('Transition: overhaul-update-docs → synthesize (guard: docsUpdated)');
          break;
        case 'overhaul-plan-review':
          missing.push('Transition: overhaul-plan-review → overhaul-delegate (guard: planReviewComplete)');
          missing.push('Transition: overhaul-delegate → overhaul-review (guard: allTasksComplete)');
          missing.push('Transition: overhaul-review → overhaul-update-docs (guard: allReviewsPassed)');
          missing.push('Transition: overhaul-update-docs → synthesize (guard: docsUpdated)');
          break;
        case 'overhaul-delegate':
          missing.push('Transition: overhaul-delegate → overhaul-review (guard: allTasksComplete)');
          missing.push('Transition: overhaul-review → overhaul-update-docs (guard: allReviewsPassed)');
          missing.push('Transition: overhaul-update-docs → synthesize (guard: docsUpdated)');
          break;
        case 'overhaul-review':
          missing.push('Transition: overhaul-review → overhaul-update-docs (guard: allReviewsPassed)');
          missing.push('Transition: overhaul-update-docs → synthesize (guard: docsUpdated)');
          break;
        case 'overhaul-update-docs':
          missing.push(
            'Transition: overhaul-update-docs → synthesize (guard: docsUpdated — set validation.docsUpdated=true)',
          );
          break;
        default:
          checkFail(
            ctx,
            'Phase is synthesize',
            `Current phase '${phase}' — not on a synthesis-eligible path for ${workflowType} workflow`,
          );
          return;
      }
      break;

    case 'debug':
      switch (phase) {
        case 'debug-validate':
          missing.push('Transition: debug-validate → debug-review (guard: validationPassed)');
          missing.push('Transition: debug-review → synthesize (guard: reviewPassed)');
          break;
        case 'debug-review':
          missing.push('Transition: debug-review → synthesize (guard: reviewPassed)');
          break;
        case 'hotfix-validate':
          missing.push('Transition: hotfix-validate → synthesize (guard: validationPassed + prRequested)');
          break;
        case 'triage':
        case 'investigate':
        case 'rca':
        case 'design':
        case 'debug-implement':
        case 'hotfix-implement':
          checkFail(
            ctx,
            'Phase is synthesize',
            `Current phase '${phase}' — multiple transitions needed before synthesize for ${workflowType} workflow`,
          );
          return;
        default:
          checkFail(
            ctx,
            'Phase is synthesize',
            `Current phase '${phase}' — not on a synthesis-eligible path for ${workflowType} workflow`,
          );
          return;
      }
      break;

    default:
      checkFail(
        ctx,
        'Phase is synthesize',
        `Current phase '${phase}' — manual phase advancement needed for ${workflowType} workflow`,
      );
      return;
  }

  if (missing.length > 0) {
    const detail =
      `Phase is '${phase}', need ${missing.length} transition(s):\n` +
      missing.map((m) => `  - ${m}`).join('\n');
    checkFail(ctx, 'Phase is synthesize', detail);
  }
}

// ─── Check 3: All tasks complete ────────────────────────────────────────────

interface Task {
  readonly id: string;
  readonly status: string;
}

function checkAllTasksComplete(
  ctx: CheckContext,
  state: Record<string, unknown>,
): void {
  const tasks = (state['tasks'] as Task[] | undefined) ?? [];

  if (tasks.length === 0) {
    checkFail(ctx, 'All tasks complete', 'No tasks found in state file');
    return;
  }

  const incomplete = tasks.filter((t) => t.status !== 'complete');
  if (incomplete.length > 0) {
    const detail = incomplete.map((t) => `${t.id} (${t.status})`).join(', ');
    checkFail(ctx, 'All tasks complete', `${incomplete.length} incomplete: ${detail}`);
    return;
  }

  checkPass(ctx, `All tasks complete (${tasks.length}/${tasks.length})`);
}

// ─── Check 4: Reviews passed ────────────────────────────────────────────────

function checkReviewsPassed(
  ctx: CheckContext,
  state: Record<string, unknown>,
): void {
  const reviews = (state['reviews'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const keys = Object.keys(reviews);

  if (keys.length === 0) {
    checkFail(ctx, 'Reviews passed', 'No review entries found in state.reviews');
    return;
  }

  const failures: string[] = [];

  for (const key of keys) {
    const entry = reviews[key];

    if (typeof entry['status'] === 'string') {
      // Flat shape
      if (!PASSING_STATUS.test(entry['status'] as string)) {
        failures.push(`${key} (status: ${entry['status']})`);
      }
    } else if (entry['specReview'] || entry['qualityReview']) {
      // Nested shape
      const spec = entry['specReview'] as Record<string, unknown> | undefined;
      const quality = entry['qualityReview'] as Record<string, unknown> | undefined;

      if (spec?.['status'] && !PASSING_STATUS.test(spec['status'] as string)) {
        failures.push(`${key}.specReview (status: ${spec['status']})`);
      }
      if (quality?.['status'] && !PASSING_STATUS.test(quality['status'] as string)) {
        failures.push(`${key}.qualityReview (status: ${quality['status']})`);
      }
    } else if (entry['passed'] === true) {
      // Legacy shape — passing
    } else if (entry['passed'] === false) {
      failures.push(`${key} (passed: false)`);
    } else {
      failures.push(`${key} (no recognizable status)`);
    }
  }

  if (failures.length > 0) {
    checkFail(ctx, 'Reviews passed', `Failing reviews: ${failures.join(', ')}`);
    return;
  }

  checkPass(ctx, `Reviews passed (${keys.length} review entries, all passing)`);
}

// ─── Check 5: No outstanding fix requests ───────────────────────────────────

function checkNoFixRequests(
  ctx: CheckContext,
  state: Record<string, unknown>,
): void {
  const tasks = (state['tasks'] as Task[] | undefined) ?? [];
  const fixTasks = tasks.filter((t) => t.status === 'needs_fixes');

  if (fixTasks.length > 0) {
    const ids = fixTasks.map((t) => t.id).join(', ');
    checkFail(ctx, 'No outstanding fix requests', `${fixTasks.length} tasks need fixes: ${ids}`);
    return;
  }

  checkPass(ctx, 'No outstanding fix requests');
}

// ─── Check 6: PR stack exists ───────────────────────────────────────────────

function checkPrStack(
  ctx: CheckContext,
  repoRoot: string,
  skipStack: boolean,
): void {
  if (skipStack) {
    checkSkip(ctx, 'PR stack exists (--skip-stack)');
    return;
  }

  let currentBranch: string;
  try {
    currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    checkFail(ctx, 'PR stack exists', 'Could not determine current branch');
    return;
  }

  if (!currentBranch) {
    checkFail(ctx, 'PR stack exists', 'Could not determine current branch');
    return;
  }

  try {
    const prJson = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'open', '--head', currentBranch, '--json', 'number'],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 15_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();

    const prs: unknown[] = JSON.parse(prJson || '[]');
    if (prs.length < 1) {
      checkFail(ctx, 'PR stack exists', `No open PRs found for branch '${currentBranch}'`);
      return;
    }

    checkPass(ctx, `PR stack exists (${prs.length} open PRs for '${currentBranch}')`);
  } catch {
    checkFail(ctx, 'PR stack exists', 'Failed querying GitHub PRs (gh pr list error)');
  }
}

// ─── Check 7: Tests pass ───────────────────────────────────────────────────

function checkTestsPass(
  ctx: CheckContext,
  repoRoot: string,
  skipTests: boolean,
  testCommand?: string,
): void {
  if (skipTests) {
    checkSkip(ctx, 'Tests pass (--skip-tests)');
    return;
  }

  let cmds: import('./detect-test-commands.js').TestCommands;
  try {
    cmds = detectTestCommands(repoRoot, testCommand);
  } catch (err) {
    checkFail(ctx, 'Tests pass', err instanceof Error ? err.message : String(err));
    return;
  }

  if (cmds.test === null) {
    checkSkip(ctx, 'Tests pass (no test runner detected)');
    return;
  }

  try {
    const [testProg, ...testArgs] = cmds.test.split(/\s+/);
    execFileSync(testProg, testArgs, {
      cwd: repoRoot,
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    checkFail(ctx, 'Tests pass', `${cmds.test} failed`);
    return;
  }

  if (cmds.typecheck !== null) {
    try {
      const [tcProg, ...tcArgs] = cmds.typecheck.split(/\s+/);
      execFileSync(tcProg, tcArgs, {
        cwd: repoRoot,
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      checkFail(ctx, 'Tests pass', `${cmds.typecheck} failed`);
      return;
    }
  }

  checkPass(ctx, 'Tests pass');
}

// ─── Handler ────────────────────────────────────────────────────────────────

export function handlePreSynthesisCheck(args: PreSynthesisCheckArgs): ToolResult {
  const { stateFile, repoRoot = '.', skipTests = false, skipStack = false, testCommand } = args;

  const ctx: CheckContext = {
    results: [],
    counters: { pass: 0, fail: 0, skip: 0 },
  };

  // Check 1: State file — all other state-dependent checks depend on this
  const state = checkStateFile(ctx, stateFile);

  if (state !== null) {
    // Check 2: Phase readiness
    checkPhaseReadiness(ctx, state);

    // Check 3: All tasks complete
    checkAllTasksComplete(ctx, state);

    // Check 4: Reviews passed
    checkReviewsPassed(ctx, state);

    // Check 5: No outstanding fix requests
    checkNoFixRequests(ctx, state);
  }

  // Check 6: PR stack (independent of state file)
  checkPrStack(ctx, repoRoot, skipStack);

  // Check 7: Tests (independent of state file)
  checkTestsPass(ctx, repoRoot, skipTests, testCommand);

  // Build report
  const total = ctx.counters.pass + ctx.counters.fail;
  const passed = ctx.counters.fail === 0;

  const reportLines = [
    '## Pre-Synthesis Readiness Report',
    '',
    `**State file:** \`${stateFile}\``,
    '',
    ...ctx.results,
    '',
    '---',
    '',
    passed
      ? `**Result: PASS** (${ctx.counters.pass}/${total} checks passed)`
      : `**Result: FAIL** (${ctx.counters.fail}/${total} checks failed)`,
  ];

  return {
    success: true,
    data: {
      passed,
      report: reportLines.join('\n'),
      checks: { ...ctx.counters },
    },
  };
}
