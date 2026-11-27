/**
 * The verifier runs approved task, phase and checkout checks in disposable images of the exact head.
 * Each child starts through the process owner. The verifier reduces each large report with the shared parsers.
 * Only compact signed facts cross the frame.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { planBoundaryCheck } from '../../config/boundary-adapters.js';
import { parseVitestResult } from '../../config/suite-reports.js';
import {
  isHostedCheckRequest, verificationValueDigest,
  type HostedBoundaryLeg, type HostedCheckFacts, type HostedCommandRun, type ReducedSuiteReport, type VerificationEvidence,
} from '../../contract/verification/harness-verification.js';
import { withCheckWorkspace, type CheckWorkspace } from './adequacy.js';
import type { AuthorizedVerification } from './authorization.js';
import type { ConfinedRun } from './processes.js';
import type { HostCheckProfile } from './provisioning.js';

type HostLeg = HostCheckProfile['legs'][number];

/** The excerpt budget of all command legs of one static analysis. It keeps the signed reply far below the frame limit. */
const STATIC_EXCERPT_BUDGET = 8000;
/** The longest detail of one classified boundary leg. */
const BOUNDARY_DETAIL_LIMIT = 1500;
/** The longest load-failure path that the reduced suite report keeps. */
const SUITE_PATH_LIMIT = 300;
/** The number of load-failure paths that the reduced suite report keeps. */
const SUITE_FILE_LIMIT = 20;

/** Text of one bounded excerpt. Control characters become spaces, and the text keeps at most `limit` characters. */
function excerpt(bytes: Buffer, limit: number): string {
  if (limit <= 0) return '';
  return bytes.toString('utf8').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, limit);
}

/** The closed end of one child. A host cancellation reads as a signal, and the workspace then refuses the operation. */
function endOf(run: ConfinedRun): HostedCommandRun['end'] {
  switch (run.reason) {
    case '': return run.code === null ? 'signal' : 'exited';
    case 'Execution deadline exceeded': return 'timeout';
    case 'Output limit exceeded': return 'output-limit';
    case 'Confinement process unavailable': return 'unavailable';
    default: return 'signal';
  }
}

/** The compact signed result of one child. The digest covers the complete output, and the excerpts are bounded. */
function commandRun(run: ConfinedRun, stdoutLimit: number, stderrLimit: number): HostedCommandRun {
  const end = endOf(run);
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  return {
    end, exitCode: end === 'exited' ? run.code : null,
    stdout: excerpt(run.stdout, stdoutLimit), stderr: excerpt(run.stderr, stderrLimit),
    outputDigest: verificationValueDigest({ stdout: hash(run.stdout), stderr: hash(run.stderr) }),
  };
}

/** The complete runner result that a shared report reader classifies. */
function readerInput(run: ConfinedRun) {
  const output = { stdout: run.stdout.toString('utf8'), stderr: run.stderr.toString('utf8') };
  switch (endOf(run)) {
    case 'exited': return { exitCode: run.code ?? -1, ...output };
    case 'timeout': return { exitCode: -1, ...output, spawnError: 'ETIMEDOUT' };
    case 'output-limit': return { exitCode: -1, ...output, spawnError: 'ENOBUFS' };
    case 'unavailable': return { exitCode: -1, ...output, spawnError: 'EUNAVAILABLE' };
    case 'signal': return { exitCode: -1, ...output, signal: 'SIGKILL' };
  }
}

/**
 * Run one approved leg. An entry runs as a script of the pinned closure under the pinned runner.
 * A binary runs from its pinned private copy. A plain leg runs the pinned runner with its own arguments.
 */
function runLeg(workspace: CheckWorkspace, leg: HostLeg, args: readonly string[]): Promise<ConfinedRun> {
  if (leg.entry !== undefined) return workspace.run(undefined, [workspace.entryPath(leg.entry), ...args]);
  if (leg.executable !== undefined) return workspace.run(leg.executable, args);
  return workspace.run(undefined, args);
}

/** Keep the first characters of a leg detail. */
function shortDetail(detail: string): string {
  return detail.slice(0, BOUNDARY_DETAIL_LIMIT);
}

/** Run each command leg, then plan, run and classify each boundary leg on the image. */
async function staticAnalysis(configured: HostCheckProfile, workspace: CheckWorkspace): Promise<HostedCheckFacts> {
  const commandLegs = configured.legs.filter(leg => leg.kind === 'command');
  const budget = Math.floor(STATIC_EXCERPT_BUDGET / Math.max(1, commandLegs.length));
  const stdoutLimit = Math.min(4096, Math.floor((budget * 2) / 3));
  const stderrLimit = Math.min(2048, budget - stdoutLimit);
  const commands: HostedCommandRun[] = [];
  for (const leg of commandLegs) commands.push(commandRun(await runLeg(workspace, leg, leg.argv.slice(1)), stdoutLimit, stderrLimit));
  const boundary: HostedBoundaryLeg[] = [];
  for (const leg of configured.legs) {
    if (leg.kind !== 'dependency-cruiser' && leg.kind !== 'semgrep-taint') continue;
    const { entry } = leg;
    const planned = planBoundaryCheck({ adapter: leg.kind, command: { state: 'resolved', argv: leg.argv, source: 'config' }, config: leg.config ?? '' }, {
      repoRoot: workspace.image, displayRoot: workspace.checkout, firstPartyGlobs: configured.firstParty,
      findDepcruise: () => entry === undefined ? undefined : join(workspace.image, 'node_modules', entry),
    });
    if (planned.adapter === 'dependency-cruiser') {
      const { plan } = planned;
      const result = plan.kind === 'settled' ? plan.result : plan.classify(readerInput(await runLeg(workspace, leg, plan.args)));
      boundary.push({ adapter: planned.adapter, name: planned.name, result: { ...result, detail: shortDetail(result.detail) } });
    } else {
      const { plan } = planned;
      const result = plan.kind === 'settled' ? plan.result : plan.classify(readerInput(await runLeg(workspace, leg, plan.args)));
      boundary.push({ adapter: planned.adapter, name: planned.name,
        result: result.status === 'PASS' ? result : { ...result, detail: shortDetail(result.detail) } });
    }
  }
  return { operation: 'static-analysis', commands, boundary };
}

/** Run codegen, typecheck and diff in order in the writable image. A failed codegen or typecheck stops the run. */
async function contractDrift(configured: HostCheckProfile, workspace: CheckWorkspace, base: string, head: string): Promise<HostedCheckFacts> {
  const legs: Extract<HostedCheckFacts, { operation: 'contract-drift' }>['legs'][number][] = [];
  for (const leg of configured.legs) {
    if (leg.kind !== 'codegen' && leg.kind !== 'typecheck' && leg.kind !== 'diff') throw new Error('Unsupported contract leg');
    const args = leg.argv.slice(1).map(token => leg.kind !== 'diff' ? token
      : token === '@baseCommit@' ? base : token === '@headCommit@' ? head : token);
    const run = commandRun(await runLeg(workspace, leg, args), 3000, 1000);
    legs.push({ kind: leg.kind, run });
    if (leg.kind !== 'diff' && (run.end !== 'exited' || run.exitCode !== 0)) break;
  }
  return { operation: 'contract-drift', legs };
}

/** Run the suite once and reduce a structured report with the shared parser. */
async function integrationSuite(configured: HostCheckProfile, workspace: CheckWorkspace): Promise<HostedCheckFacts> {
  const leg = configured.legs[0];
  if (leg === undefined || leg.kind !== 'integration' || configured.legs.length !== 1) throw new Error('Unsupported integration leg');
  const run = await runLeg(workspace, leg, leg.argv.slice(1));
  const structured = configured.report === 'vitest-json';
  const parsed = structured && endOf(run) === 'exited' ? parseVitestResult(run.stdout.toString('utf8')) : null;
  const report: ReducedSuiteReport | null = parsed === null ? null : {
    passed: parsed.passed, failedSuites: parsed.failedSuites, failedTests: parsed.failedTests, loadFailures: parsed.loadFailures,
    totalTests: parsed.totalTests, failCount: parsed.failCount,
    loadFailureFiles: parsed.loadFailureFiles.slice(0, SUITE_FILE_LIMIT).map(file => file.slice(0, SUITE_PATH_LIMIT)),
    loadFailureFileTotal: parsed.loadFailureFiles.length,
  };
  return { operation: 'integration-suite', run: commandRun(run, structured ? 0 : 4000, 2000), report };
}

/** Run each declared test once, or the whole command once in the form that takes no file list. */
async function specCoverage(configured: HostCheckProfile, workspace: CheckWorkspace, tests: readonly string[]): Promise<HostedCheckFacts> {
  const leg = configured.legs[0];
  if (leg === undefined || leg.kind !== 'probe' || configured.legs.length !== 1) throw new Error('Unsupported probe leg');
  const form = configured.files ?? 'as-arguments';
  const groups = form === 'none' ? [tests] : tests.map(test => [test]);
  const runs: HostedCommandRun[] = [];
  for (const files of groups) {
    const placed = form === 'none' ? [] : form === 'after-separator' ? ['--', ...files] : files;
    runs.push(commandRun(await runLeg(workspace, leg, [...leg.argv.slice(1), ...placed]), 0, 0));
  }
  return { operation: 'spec-coverage', runs };
}

/**
 * Run the test and typecheck legs of a lifecycle check in order in the image of the exact checkout head.
 * A plan that stops after a failed test leg runs no later leg, as its local route stops.
 */
async function lifecycle(configured: HostCheckProfile, workspace: CheckWorkspace): Promise<HostedCheckFacts> {
  const legs: Extract<HostedCheckFacts, { operation: 'lifecycle' }>['legs'][number][] = [];
  for (const leg of configured.legs) {
    if (leg.kind !== 'command' && leg.kind !== 'typecheck') throw new Error('Unsupported lifecycle leg');
    const run = commandRun(await runLeg(workspace, leg, leg.argv.slice(1)), 3000, 1000);
    legs.push({ name: leg.name, kind: leg.kind, run });
    if (leg.kind === 'command' && configured.onTestFailure === 'stop' && (run.end !== 'exited' || run.exitCode !== 0)) break;
  }
  return { operation: 'lifecycle', legs };
}

/** Each child that the facts record ended with exit 0. */
function everyRunPassed(facts: HostedCheckFacts): boolean {
  const passed = (run: HostedCommandRun) => run.end === 'exited' && run.exitCode === 0;
  switch (facts.operation) {
    case 'static-analysis': return facts.commands.every(passed);
    case 'contract-drift': return facts.legs.every(leg => passed(leg.run));
    case 'integration-suite': return passed(facts.run);
    case 'spec-coverage': return facts.runs.every(passed);
    case 'lifecycle': return facts.legs.every(leg => passed(leg.run));
  }
}

/** Run one authorized check in its disposable workspace and return the compact facts as the signed outcome. */
export async function runHostedCheck(authorized: AuthorizedVerification, signal: AbortSignal): Promise<VerificationEvidence['outcome']> {
  const { request, profile } = authorized;
  const configured = profile.check;
  if (!isHostedCheckRequest(request) || configured === undefined || configured.operation !== request.operation) {
    throw new Error('Check authorization required');
  }
  const facts = await withCheckWorkspace(authorized, signal, workspace => {
    switch (request.operation) {
      case 'static-analysis': return staticAnalysis(configured, workspace);
      case 'contract-drift': return contractDrift(configured, workspace, request.subject.baseCommit, request.subject.headCommit);
      case 'integration-suite': return integrationSuite(configured, workspace);
      case 'spec-coverage': return specCoverage(configured, workspace, request.selection.tests);
      case 'lifecycle': return lifecycle(configured, workspace);
    }
  });
  const passed = everyRunPassed(facts);
  return {
    check: facts, status: passed ? 'passed' : 'failed', exitCode: null,
    reason: passed ? 'Every approved check child exited 0' : 'An approved check child did not exit 0',
    stdoutBase64: '', stderrBase64: '',
  };
}
