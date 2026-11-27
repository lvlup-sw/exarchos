/**
 * The local executor of the approved checks: static analysis, the integration suites, contract drift, spec coverage and the lifecycle checks.
 * A command runs only when its argv is a leg of the approved plan, which the pinned or the live resolved profile gives.
 * The program resolves once through PATH. A program inside the checkout refuses, except a runner under node_modules/.bin.
 * Each leg runs in its own process group with a time cap, an output cap and the scrubbed store environment.
 *
 * Each check binds its request and claims an attempt before a process starts. A stored terminal observation replays with no process.
 * A retry of an attempt with no terminal observation records that attempt as incomplete, then starts the next attempt.
 */
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, mkdtempSync, rmSync, statSync, type RmOptions } from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';

import { canonicalJson } from '../../contract/request-context.js';
import { checkPlanDigest, verificationJson, verificationValueDigest, type CheckPlan } from '../../contract/verification/harness-verification.js';
import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import { PLUGIN_MODE_ENV_KEYS, STORE_LOCATION_ENV_KEYS } from '../../utils/paths.js';
import type { EventStore } from '../../events/store.js';
import { isPidAlive, isWindowsBatchFile, spawnCommand, windowsBatchLaunch } from '../../utils/process.js';
import { processObservationalGitPath } from '../../utils/git-tree.js';
import { loadPreparedCustody, selectPreparedAuthority } from '../../workflow/capsule/prepared-custody.js';
import { WorkflowStartedData, type WorkflowEvent } from '../../events/schemas.js';
import { foldWorkflowState } from '../../projections/guard-input/fold.js';
import { createWorktreesReducer } from '../worktree/projections/worktrees.js';
import { ContentDigestV1Schema } from '../../workflow/admission/types.js';
import type { CommandResult } from '../pure/static-analysis.js';
import type { ToolResult } from '../../format.js';
import {
  closedListingCleanTree, HostedAdequacyPending, hostedPendingResult, storedEvidenceReplay, storedEvidenceWithoutObservation,
} from '../gates/gate-runner.js';
import { observeCurrentCheckout, type CurrentCheckoutRead, type ProfiledGateArgs } from '../gates/gate-utils.js';
import { withDisposableCopy } from './disposable-copy.js';

/** The name prefix of the scratch directory of one probe test run, under the temporary directory of the system. */
export const PROBE_SCRATCH_PREFIX = 'exarchos-probe-';

/** The options of each delete of a probe scratch directory. The retries give a transient Windows lock time to end. */
const PROBE_SCRATCH_REMOVE: RmOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };

/** True when `key` names the environment key `name`. Windows reads environment keys without case, so the match there ignores case. */
function isEnvKey(key: string, name: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? key.toUpperCase() === name.toUpperCase() : key === name;
}

/**
 * Returns the environment of one probe test run: a copy of `parent` in which each store key points under `scratchDir`.
 * No plugin-mode key stays. A deleted store key is not enough, because the resolver then falls back to the home directory.
 * Thus a test that resolves its store through these keys does not write the live store that settle writes in the same call.
 * `HOME` and `XDG_STATE_HOME` stay, so a test that builds a store path from them can still reach the live store.
 *
 * @internal Exported so that a test can read the environment without a process.
 */
export function probeTestEnvironment(
  parent: NodeJS.ProcessEnv,
  scratchDir: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const storeKeys = Object.entries(STORE_LOCATION_ENV_KEYS);
  const removed = [...PLUGIN_MODE_ENV_KEYS, ...storeKeys.map(([, key]) => key)];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (!removed.some((name) => isEnvKey(key, name, platform))) env[key] = value;
  }
  for (const [location, key] of storeKeys) env[key] = join(scratchDir, location);
  return env;
}

/** Deletes a probe scratch directory. A failed delete leaves the directory, and the verdict of the run stays. */
export function removeProbeScratch(scratchDir: string): void {
  try {
    rmSync(scratchDir, PROBE_SCRATCH_REMOVE);
  } catch {
    return;
  }
}

/**
 * The singleton stream of the worktree registry, as the worktree manager names it.
 * The executor does not import the manager, because the manager loads the storage backend.
 */
const WORKTREE_REGISTRY_STREAM = 'worktrees';

/** The time cap of one leg when the check names none. */
export const DEFAULT_LEG_TIMEOUT_MS = 600_000;

/** The largest time cap of one leg. A larger request gets this cap. */
export const MAXIMUM_LEG_TIMEOUT_MS = 900_000;

/** The output cap of one leg, over stdout and stderr together. */
export const LEG_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

/** The largest number of attempts of one check request. */
const MAXIMUM_ATTEMPTS = 64;

/** The placeholders that a leg can name. Each one takes an exact commit of the bound coordinate. */
const COMMIT_PLACEHOLDERS: readonly string[] = ['@baseCommit@', '@headCommit@'];

/** The checks that run in this executor. */
export type CheckOperation = 'static-analysis' | 'contract-drift' | 'integration-suite' | 'spec-coverage' | 'lifecycle';

/**
 * The closed end of one leg. A refused leg started no process. An unavailable leg did not start.
 * A stored leg of the retired source-revert probe names the reverted image. The field stays, so those stored observations still parse.
 */
export const LegObservation = z.object({
  argv: z.array(z.string()).min(1),
  image: z.literal('reverted').optional(),
  end: z.enum(['exited', 'timeout', 'output-limit', 'unavailable', 'signal', 'refused']),
  exitCode: z.number().int().nullable(),
  signal: z.string().optional(),
  code: z.string().optional(),
  stdout: z.string(),
  stderr: z.string(),
  detail: z.string().optional(),
}).strict();
export type LegObservation = z.infer<typeof LegObservation>;

/** The error code of a check that the local executor refused. No leg ran, or a leg changed the working directory. */
export const LOCAL_CHECK_REFUSED = 'LOCAL_CHECK_REFUSED';

/** The failed carrier of a refused check. The gate runner records it with no verdict. */
export function refusedCheckResult(reason: string): ToolResult {
  return { success: false, error: { code: LOCAL_CHECK_REFUSED, message: reason } };
}

/**
 * The result of the pending signal of a direct call: the existing pending code. A segment call keeps the signal, so its segment stays retryable.
 * Any other error stays thrown.
 */
export function pendingOfDirectCall(error: unknown, bound: boolean): ToolResult {
  if (bound || !(error instanceof HostedAdequacyPending)) throw error;
  return hostedPendingResult(error);
}

/** The terminal observation of one attempt: its root, each leg in order, and whether the live checkout stayed unchanged. */
const CheckObservation = z.object({
  version: z.literal(1),
  root: z.string().min(1),
  legs: z.array(LegObservation),
  tree: z.enum(['unchanged', 'changed']),
}).strict();
type CheckObservation = z.infer<typeof CheckObservation>;

/** The claim of one attempt. The process identity tells a live attempt of another process from an interrupted one. */
const AttemptClaim = z.object({ version: z.literal(1), attempt: z.number().int().positive(), pid: z.number().int(), nonce: z.string().min(1) }).strict();

/** The binding of one terminal observation in the run bundle. */
const ObservationBinding = z.object({ version: z.literal(1), digest: ContentDigestV1Schema }).strict();

/**
 * The integration subject of a suite at the integration tip. The working directory must hold the full ref at the observed tip.
 * The attempt names the outer operation, the ref, the tip, the profile and the sorted accepted heads.
 * It takes the place of the dispatch operation in the request key.
 */
export interface IntegrationCheckSubject {
  readonly ref: string;
  readonly tip: string;
  readonly attempt: string;
}

/**
 * One request of one check. The plan holds every approved leg, and the coordinate binds a task segment.
 * A check with no stream is a standalone check, and it runs in any registered branch checkout.
 * A check of a stream with a prepared scope runs only in a worktree of that repository.
 * A check of a stream with no prepared scope runs only in a worktree of the workflow repository or a registered worktree of the workflow.
 */
export interface ApprovedCheckRequest {
  readonly eventStore: EventStore;
  readonly operation: CheckOperation;
  readonly streamId?: string;
  readonly phaseAttemptId?: string;
  readonly taskId?: string;
  readonly plan: CheckPlan;
  readonly profileDigest: string;
  /** The working directory that the gate names. It must be the canonical root of its checkout. */
  readonly checkout: string;
  /** The head that the gate observed before the request. A working directory at another head refuses. */
  readonly head?: string;
  readonly coordinate?: ProfiledGateArgs['coordinate'];
  readonly selection?: readonly string[];
  /** `checkout` runs read-only legs in the checkout itself. `disposable-copy` runs legs that write in a copy of the exact head. */
  readonly workspace: 'checkout' | 'disposable-copy';
  /** The integration subject of a suite at the integration tip. */
  readonly integration?: IntegrationCheckSubject;
  readonly legTimeoutMs?: number;
}

/** One leg of the plan, its commit substitutions and the operands that the gate appends, such as declared test files. */
export interface LegRequest {
  readonly leg: number;
  readonly substitute?: Readonly<Record<string, string>>;
  readonly append?: readonly string[];
}

/** The workspace of one attempt. A replay gives the stored legs in order and starts no process. */
export interface CheckSession {
  readonly root: string;
  readonly replayed: boolean;
  run(request: LegRequest): Promise<LegObservation>;
}

/**
 * The outcome of one check: the value of its body and the attempt that gave it, or a refusal before or after the legs.
 * `observation` is the digest of the stored terminal observation of the attempt.
 */
export type ApprovedCheckOutcome<T> =
  | { readonly kind: 'ran'; readonly value: T; readonly replayed: boolean; readonly attempt: number; readonly observation: string }
  | { readonly kind: 'refused'; readonly reason: string };

/** The executor of one check. A test passes its own executor to a gate. */
export type CheckExecutor = <T>(request: ApprovedCheckRequest, body: (session: CheckSession) => Promise<T>) => Promise<ApprovedCheckOutcome<T>>;

/** The request keys that run in this process now. A second run of the same key waits as pending. */
const activeRequests = new Set<string>();

/**
 * The runner result of one leg, as the pure interpreters read it.
 * A timeout gives `ETIMEDOUT`, an output overrun gives `ENOBUFS`, a missing program gives `ENOENT` and a refusal gives `EREFUSED`.
 */
export function commandResultOf(observation: LegObservation): CommandResult {
  const output = { stdout: observation.stdout, stderr: observation.stderr };
  switch (observation.end) {
    case 'exited': return { exitCode: observation.exitCode ?? -1, ...output };
    case 'timeout': return { exitCode: -1, ...output, spawnError: 'ETIMEDOUT' };
    case 'output-limit': return { exitCode: -1, ...output, spawnError: 'ENOBUFS' };
    case 'signal': return { exitCode: -1, ...output, signal: observation.signal ?? 'SIGKILL' };
    case 'unavailable': return { exitCode: 127, stdout: '', stderr: observation.detail ?? '', spawnError: observation.code ?? 'ENOENT' };
    case 'refused': return { exitCode: 126, stdout: '', stderr: observation.detail ?? '', spawnError: 'EREFUSED' };
  }
}

/** True for an operand that names a relative path inside the root, or the `--` separator. */
function safeOperand(token: string): boolean {
  if (token === '--') return true;
  return token.length > 0 && token.length <= 1024 && !token.startsWith('-') && !isAbsolute(token) && !token.includes('\0')
    && token.split(/[\\/]/).every(part => part !== '..');
}

/** The argv of one leg request: the approved leg, its commit substitutions, then the appended operands. */
export function legArgv(plan: CheckPlan, request: LegRequest): readonly string[] {
  const leg = plan.legs[request.leg];
  if (leg === undefined) throw new Error('The leg is not in the approved plan');
  const substitute = request.substitute ?? {};
  for (const [key, value] of Object.entries(substitute)) {
    if (!COMMIT_PLACEHOLDERS.includes(key) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('A substitution names no exact commit');
  }
  const append = request.append ?? [];
  if (append.length > 256 || !append.every(safeOperand)) throw new Error('An appended operand is not a relative path inside the root');
  return [...leg.argv.map((token, index) => index === 0 ? token : substitute[token] ?? token), ...append];
}

/** True when `path` is `root` or lies below it. */
function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The executable names of one program. On win32 each extension of PATHEXT applies. */
function executableNames(program: string): readonly string[] {
  if (process.platform !== 'win32') return [program];
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return [program, ...extensions.map(extension => program + extension.toLowerCase())];
}

/** The first regular executable file of `names` in `directory`, or undefined. */
function executableIn(directory: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const candidate = join(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      if (process.platform !== 'win32') accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The outcome of one program resolution. */
type ProgramResolution =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'refused' | 'unavailable'; readonly detail: string };

/**
 * Resolve one program once. A bare name searches each absolute PATH entry, then node_modules/.bin of the root and of each parent.
 * A name with a path resolves against the root. A program inside the checkout refuses, except a runner in node_modules/.bin of the checkout.
 */
async function resolveProgram(program: string, checkout: string): Promise<ProgramResolution> {
  const runnerDirectory = join(checkout, 'node_modules', '.bin');
  const refused: ProgramResolution = { kind: 'refused',
    detail: `The program ${program} lies inside the checkout, so the checkout could choose it. Only a runner in node_modules/.bin runs from the checkout.` };
  let candidate: string | undefined;
  if (program.includes('/') || program.includes('\\')) {
    const full = resolve(checkout, program);
    if (inside(checkout, full) && dirname(full) !== runnerDirectory) return refused;
    candidate = executableIn(dirname(full), executableNames(basename(full)));
  } else {
    const names = executableNames(program);
    for (const entry of (process.env.PATH ?? '').split(delimiter)) {
      if (entry === '' || !isAbsolute(entry)) continue;
      candidate = executableIn(entry, names);
      if (candidate !== undefined) break;
    }
    for (let directory = checkout; candidate === undefined; directory = dirname(directory)) {
      candidate = executableIn(join(directory, 'node_modules', '.bin'), names);
      if (dirname(directory) === directory) break;
    }
  }
  if (candidate === undefined) return { kind: 'unavailable', detail: `The program ${program} is not on PATH and is not a project-local runner.` };
  const real = await realpath(candidate);
  if ((inside(checkout, candidate) || inside(checkout, real)) && dirname(candidate) !== runnerDirectory) return refused;
  return { kind: 'resolved', path: candidate };
}

/** Stop the process group of one leg. On win32 the tree of the child stops through taskkill. */
function stopGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      spawnCommand(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).once('error', () => undefined);
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    return;
  }
}

/**
 * Run one resolved leg in its own process group, with a new scratch store directory for each run.
 * A timeout or an output overrun stops the whole group. The output keeps the bytes up to the cap.
 */
function spawnLeg(path: string, argv: readonly string[], cwd: string, timeoutMs: number, extraEnv: NodeJS.ProcessEnv): Promise<LegObservation> {
  let scratch: string;
  try {
    scratch = mkdtempSync(join(os.tmpdir(), PROBE_SCRATCH_PREFIX));
  } catch (error) {
    return Promise.resolve({ argv: [...argv], end: 'unavailable', exitCode: null, stdout: '', stderr: '',
      detail: `The scratch directory of the leg was not made: ${error instanceof Error ? error.message : String(error)}` });
  }
  const batch = isWindowsBatchFile(path);
  const launch = batch ? windowsBatchLaunch(path, argv.slice(1)) : { file: path, args: argv.slice(1) };
  return new Promise<LegObservation>((settle) => {
    const chunks: { readonly stream: 'stdout' | 'stderr'; readonly bytes: Buffer }[] = [];
    let total = 0;
    let stopped: 'timeout' | 'output-limit' | undefined;
    let failure: { readonly message: string; readonly code?: string } | undefined;
    const child = spawnCommand(launch.file, launch.args, {
      cwd, env: { ...probeTestEnvironment(process.env, scratch), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments: batch,
    });
    const stop = (end: 'timeout' | 'output-limit') => {
      if (stopped !== undefined) return;
      stopped = end;
      stopGroup(child.pid);
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const collect = (stream: 'stdout' | 'stderr') => (bytes: Buffer) => {
      if (stopped !== undefined) return;
      const room = LEG_OUTPUT_LIMIT_BYTES - total;
      chunks.push({ stream, bytes: bytes.length > room ? bytes.subarray(0, room) : bytes });
      total += bytes.length;
      if (total > LEG_OUTPUT_LIMIT_BYTES) stop('output-limit');
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    child.once('error', (error) => {
      const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
      failure = { message: error.message, ...(code === undefined ? {} : { code }) };
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      removeProbeScratch(scratch);
      const text = (stream: 'stdout' | 'stderr') => Buffer.concat(chunks.filter(chunk => chunk.stream === stream).map(chunk => chunk.bytes)).toString('utf8');
      const output = { argv: [...argv], stdout: text('stdout'), stderr: text('stderr') };
      if (stopped !== undefined) settle({ ...output, end: stopped, exitCode: null });
      else if (failure !== undefined && code === null) {
        settle({ ...output, end: 'unavailable', exitCode: null, detail: failure.message, ...(failure.code === undefined ? {} : { code: failure.code }) });
      }
      else if (code === null) settle({ ...output, end: 'signal', exitCode: null, ...(signal === null ? {} : { signal }) });
      else settle({ ...output, end: 'exited', exitCode: code });
    });
  });
}

/** The time cap of one leg: the requested cap inside the maximum, or the default. */
function legTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return DEFAULT_LEG_TIMEOUT_MS;
  return Math.min(requested, MAXIMUM_LEG_TIMEOUT_MS);
}

/** The observed checkout of one request, or the reason of a refusal. */
type CheckoutRead =
  | { readonly kind: 'observed'; readonly checkout: string; readonly repository: string; readonly gitDir: string; readonly head: string;
    readonly reads: Extract<CurrentCheckoutRead, { readonly kind: 'observed' }> }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * The prepared scope of the stream, or a refusal when it cannot be read.
 * It is undefined when the stream has no prepared authority.
 */
async function preparedScope(eventStore: EventStore, streamId: string, events: readonly WorkflowEvent[]):
  Promise<{ readonly repository: string; readonly checkout: string } | undefined | { readonly refused: string }> {
  const selection = selectPreparedAuthority(events, streamId);
  if (selection === undefined) return undefined;
  try {
    return (await loadPreparedCustody(selection, eventStore.bundleStore)).capsule.settlementContract.scope;
  } catch {
    return { refused: 'The prepared authority of the workflow cannot be read, so no scope confines the working directory.' };
  }
}

/** True when two paths name the same directory after each resolves its links. */
async function samePath(left: string, right: string): Promise<boolean> {
  return await realpath(left).catch(() => left) === await realpath(right).catch(() => right);
}

/** The repository key of a common Git directory: the parent of a directory named .git, or the directory itself. Workflow start records this key. */
function repositoryKey(repository: string): string {
  return basename(repository) === '.git' ? dirname(repository) : repository;
}

/** The absolute worktree paths that the folded workflow state names: each `path` of the state worktrees, and each worktree of a task. */
function stateWorktreePaths(events: readonly WorkflowEvent[]): readonly string[] {
  const state = foldWorkflowState(events);
  const paths: string[] = [];
  for (const entry of Object.values(state.worktrees)) {
    if (entry !== null && typeof entry === 'object' && 'path' in entry && typeof entry.path === 'string') paths.push(entry.path);
  }
  for (const task of state.tasks) {
    for (const value of [task.worktree, task.worktreePath]) if (typeof value === 'string') paths.push(value);
  }
  return paths.filter(path => isAbsolute(path));
}

/**
 * True when the checkout belongs to a workflow with no prepared scope.
 * The checkout must be in the repository that the workflow start names, a worktree of the workflow state, or a registered worktree of the workflow.
 */
async function workflowHoldsCheckout(eventStore: EventStore, streamId: string, events: readonly WorkflowEvent[], checkout: string,
  repository: string): Promise<boolean> {
  for (const event of events) {
    const started = event.type === 'workflow.started' ? WorkflowStartedData.safeParse(event.data) : undefined;
    const repoRoot = started?.success === true ? started.data.repoRoot : undefined;
    if (repoRoot !== undefined && await samePath(repoRoot, repositoryKey(repository))) return true;
  }
  for (const path of stateWorktreePaths(events)) if (await samePath(path, checkout)) return true;
  const reducer = createWorktreesReducer();
  const registry = (await eventStore.query(WORKTREE_REGISTRY_STREAM)).reduce((state, event) => reducer.apply(state, event), reducer.initial);
  for (const entry of Object.values(registry.worktrees)) {
    if (entry.featureId === streamId && (await samePath(entry.path, checkout) || entry.worktreeId === checkout)) return true;
  }
  return false;
}

/** The terms of the working directory of one check. A standalone check names no store and no stream. */
type WorkingDirectoryTerms = Pick<ApprovedCheckRequest, 'checkout' | 'head' | 'coordinate' | 'integration' | 'streamId'> & { readonly eventStore?: EventStore };

/**
 * Observe the working directory. It must be the canonical root of a registered branch checkout.
 * A segment checkout must hold the coordinate repository and head. A check with no stream is a standalone check.
 *
 * A direct call of a stream with a prepared scope must name the repository of that scope. With no prepared scope, it must name a worktree of the workflow.
 * An integration suite must run in the checkout of the prepared scope, on the integration ref at the observed tip.
 */
async function observeWorkingDirectory(request: WorkingDirectoryTerms): Promise<CheckoutRead> {
  const checkout = await realpath(request.checkout).catch(() => undefined);
  if (checkout === undefined) return { kind: 'refused', reason: `The working directory ${request.checkout} does not exist.` };
  const gitPath = processObservationalGitPath();
  if (gitPath === undefined) return { kind: 'refused', reason: 'No usable Git executable observes the working directory.' };
  const observed = await observeCurrentCheckout(gitPath, checkout);
  if (observed.kind === 'refused') return { kind: 'refused', reason: `The working directory is not a registered branch checkout: ${observed.reason}` };
  const value = observed.checkout;
  if (await realpath(value.checkout).catch(() => value.checkout) !== checkout) {
    return { kind: 'refused', reason: 'The working directory is not the root of its checkout.' };
  }
  if (request.head !== undefined && value.head !== request.head) {
    return { kind: 'refused', reason: 'The working directory moved from the head that the gate observed.' };
  }
  const coordinate = request.coordinate;
  if (coordinate !== undefined) {
    if (value.repository !== coordinate.repository || value.head !== coordinate.observedHeadCommit) {
      return { kind: 'refused', reason: 'The working directory is not the checkout of the bound coordinate.' };
    }
  } else {
    const { eventStore, streamId } = request;
    const events = eventStore === undefined || streamId === undefined ? undefined : await eventStore.query(streamId);
    const scoped = eventStore === undefined || streamId === undefined || events === undefined ? undefined : await preparedScope(eventStore, streamId, events);
    if (scoped !== undefined && 'refused' in scoped) return { kind: 'refused', reason: scoped.refused };
    if (scoped !== undefined && !await samePath(scoped.repository, value.repository)) {
      return { kind: 'refused', reason: 'The working directory is not a worktree of the repository that the workflow prepared.' };
    }
    if (scoped === undefined && eventStore !== undefined && streamId !== undefined && events !== undefined
      && !await workflowHoldsCheckout(eventStore, streamId, events, checkout, value.repository)) {
      return { kind: 'refused', reason: 'The working directory is not a registered worktree of the workflow or a worktree of its repository.' };
    }
    const integration = request.integration;
    if (integration !== undefined && (scoped === undefined || !await samePath(scoped.checkout, checkout))) {
      return { kind: 'refused', reason: 'The working directory is not the integration checkout of the prepared scope.' };
    }
    if (integration !== undefined && (value.branch !== integration.ref || value.head !== integration.tip)) {
      return { kind: 'refused', reason: 'The integration checkout does not hold the integration ref at the observed tip.' };
    }
  }
  return { kind: 'observed', checkout, repository: value.repository, gitDir: value.gitDir, head: value.head, reads: observed };
}

/** True when the closed listings show the exact head with no change. */
async function cleanAt(read: Extract<CheckoutRead, { kind: 'observed' }>): Promise<boolean> {
  return closedListingCleanTree(read.reads.observer.reads, read.gitDir, read.checkout, read.head);
}

/** The binding keys of one request. */
function keysOf(requestKey: string) {
  const prefix = `local-check:${requestKey}`;
  return {
    claim: (attempt: number) => `${prefix}:claim:${attempt}`,
    result: (attempt: number) => `${prefix}:result:${attempt}`,
    incomplete: (attempt: number) => `${prefix}:incomplete:${attempt}`,
  };
}

/** A session that gives the stored legs in order. A leg that differs from its stored argv, or a stored leg in another image, leaves the check pending. */
function replaySession(plan: CheckPlan, stored: CheckObservation): CheckSession {
  let index = 0;
  return {
    root: stored.root,
    replayed: true,
    async run(request) {
      const argv = legArgv(plan, request);
      const leg = stored.legs[index];
      index++;
      if (leg === undefined || verificationJson(leg.argv) !== verificationJson(argv) || leg.image !== undefined) {
        throw new HostedAdequacyPending('The stored check observation does not match the replayed check.');
      }
      return leg;
    },
  };
}

/** A session that runs each leg live and records it. Each program resolves once. */
function liveSession(plan: CheckPlan, root: string, checkout: string, timeoutMs: number, env: NodeJS.ProcessEnv,
  legs: LegObservation[]): CheckSession {
  const programs = new Map<string, Promise<ProgramResolution>>();
  return {
    root,
    replayed: false,
    async run(request) {
      let argv: readonly string[];
      try {
        argv = legArgv(plan, request);
      } catch (error) {
        const leg = plan.legs[request.leg];
        const refused: LegObservation = { argv: leg === undefined ? ['?'] : [...leg.argv], end: 'refused', exitCode: null, stdout: '', stderr: '',
          detail: error instanceof Error ? error.message : String(error) };
        legs.push(refused);
        return refused;
      }
      const program = argv[0] ?? '';
      let resolution = programs.get(program);
      if (resolution === undefined) {
        resolution = resolveProgram(program, checkout);
        programs.set(program, resolution);
      }
      const resolved = await resolution;
      let observation: LegObservation;
      if (resolved.kind === 'resolved') {
        observation = await spawnLeg(resolved.path, argv, root, timeoutMs, env);
      } else {
        observation = { argv: [...argv], end: resolved.kind, exitCode: null, stdout: '', stderr: '', detail: resolved.detail };
      }
      legs.push(observation);
      return observation;
    },
  };
}

/** The terms of the workspace of one attempt. */
type AttemptTerms = Pick<ApprovedCheckRequest, 'plan' | 'workspace' | 'coordinate' | 'legTimeoutMs'>;

/**
 * The live run of one claimed attempt. It builds the workspace, runs the body and checks the live checkout after the run.
 * A direct call starts from a clean tree. A segment call checks the tree after the run when the tree was clean before it, so a leg that writes the checkout is seen.
 */
async function runAttempt<T>(
  request: AttemptTerms, read: Extract<CheckoutRead, { kind: 'observed' }>, body: (session: CheckSession) => Promise<T>,
): Promise<{ readonly value: T; readonly observation: CheckObservation }> {
  const legs: LegObservation[] = [];
  const timeoutMs = legTimeout(request.legTimeoutMs);
  let value: T;
  let root = read.checkout;
  const cleanBefore = request.coordinate === undefined || await cleanAt(read);
  if (request.workspace === 'disposable-copy') {
    const source = { checkout: read.checkout, gitDir: read.gitDir, repository: read.repository, head: read.head, reads: read.reads.observer.reads };
    value = await withDisposableCopy(source, (copy) => {
      root = copy;
      return body(liveSession(request.plan, copy, read.checkout, timeoutMs, { GIT_CEILING_DIRECTORIES: dirname(copy) }, legs));
    });
  } else {
    value = await body(liveSession(request.plan, read.checkout, read.checkout, timeoutMs, {}, legs));
  }
  const unchanged = !cleanBefore || await cleanAt(read);
  return { value, observation: { version: 1, root, legs, tree: unchanged ? 'unchanged' : 'changed' } };
}

/** The reason of a check that changed the live checkout. */
const CHANGED_TREE_REASON = 'The check changed the working directory, so its result is not evidence of the exact head.';

/**
 * Run one approved check. The working directory and its head are observed first, and a direct call needs a clean tree.
 * The request binds its operation, the dispatch operation, the coordinates, the profile digest and the plan digest.
 * An integration request binds its attempt in place of the dispatch operation, so a later settle call of the same attempt replays it.
 *
 * A stored terminal observation replays. Otherwise an attempt is claimed before any process starts, and its observation is stored after the body.
 * Inside a provider run whose operation already has stored evidence, a check with no stored observation starts no process.
 * A refused working directory there also has no observation. Each throws the no-observation signal, and the gate runner replays the stored evidence record.
 */
export const runApprovedCheck: CheckExecutor = async <T>(request: ApprovedCheckRequest, body: (session: CheckSession) => Promise<T>) => {
  const operationId = getDispatchContext()?.operationId;
  if (operationId === undefined) return { kind: 'refused', reason: 'A local check runs only inside a dispatched operation.' };
  const read = await observeWorkingDirectory(request);
  if (read.kind === 'refused' && storedEvidenceReplay()) throw storedEvidenceWithoutObservation(`This operation has stored evidence, and no check observation of it can be read: ${read.reason}`);
  if (read.kind === 'refused') return read;
  if (request.coordinate === undefined && !await cleanAt(read)) {
    return { kind: 'refused', reason: 'The working directory has uncommitted changes. Commit them first, then run the check again.' };
  }
  const requestKey = verificationValueDigest({
    version: 1, operation: request.operation, operationId: request.integration?.attempt ?? operationId, streamId: request.streamId ?? null,
    ...(request.phaseAttemptId === undefined ? {} : { phaseAttemptId: request.phaseAttemptId }), taskId: request.taskId ?? null, checkout: read.checkout, repository: read.repository, head: read.head,
    base: request.coordinate?.diffBaseCommit ?? null, blockers: request.coordinate?.blockers.map(blocker => blocker.headCommit) ?? [],
    profileDigest: request.profileDigest, planDigest: checkPlanDigest(request.plan), selection: request.selection ?? [], workspace: request.workspace,
    ...(request.integration === undefined ? {} : { ref: request.integration.ref }),
  });
  if (activeRequests.has(requestKey)) throw new HostedAdequacyPending('The same check is running in this process.');
  activeRequests.add(requestKey);
  try {
    const backend = request.eventStore.getAppender().ensureSqliteBackendSync();
    const keys = keysOf(requestKey);
    let attempt = 0;
    while (attempt < MAXIMUM_ATTEMPTS && backend.lookupSegmentInput(keys.claim(attempt + 1)) !== undefined) attempt++;
    const stored = attempt === 0 ? undefined : backend.lookupSegmentInput(keys.result(attempt));
    if (stored !== undefined) {
      const binding = ObservationBinding.parse(JSON.parse(stored));
      const observation = CheckObservation.parse(JSON.parse((await request.eventStore.bundleStore.resolve(binding.digest)).toString('utf8')));
      const value = await body(replaySession(request.plan, observation));
      return observation.tree === 'changed' ? { kind: 'refused', reason: CHANGED_TREE_REASON }
        : { kind: 'ran', value, replayed: true, attempt, observation: binding.digest.value };
    }
    if (storedEvidenceReplay()) throw storedEvidenceWithoutObservation('This operation has stored evidence but no terminal check observation, so no new run starts.');
    if (attempt > 0) {
      const previous = backend.lookupSegmentInput(keys.claim(attempt));
      const claim = previous === undefined ? undefined : AttemptClaim.safeParse(JSON.parse(previous));
      if (claim?.success === true && claim.data.pid !== process.pid && isPidAlive(claim.data.pid)) {
        throw new HostedAdequacyPending('Another process holds the running attempt of this check.');
      }
      backend.bindSegmentInput(keys.incomplete(attempt), canonicalJson({ version: 1, attempt }));
    }
    if (attempt >= MAXIMUM_ATTEMPTS) return { kind: 'refused', reason: 'The check has no attempt left. Each earlier attempt is incomplete.' };
    const nonce = randomUUID();
    const won = backend.bindSegmentInput(keys.claim(attempt + 1), canonicalJson({ version: 1, attempt: attempt + 1, pid: process.pid, nonce }));
    if (AttemptClaim.parse(JSON.parse(won)).nonce !== nonce) throw new HostedAdequacyPending('Another run claimed this attempt of the check.');
    const { value, observation } = await runAttempt(request, read, body);
    const digest = await request.eventStore.bundleStore.put(Buffer.from(canonicalJson(observation), 'utf8'));
    backend.bindSegmentInput(keys.result(attempt + 1), canonicalJson({ version: 1, digest }));
    return observation.tree === 'changed' ? { kind: 'refused', reason: CHANGED_TREE_REASON }
      : { kind: 'ran', value, replayed: false, attempt: attempt + 1, observation: digest.value };
  } finally {
    activeRequests.delete(requestKey);
  }
};

/** The request of one standalone check: the approved plan and the working directory. No store records it. */
export interface StandaloneCheckRequest {
  readonly plan: CheckPlan;
  readonly checkout: string;
  readonly legTimeoutMs?: number;
}

/** The outcome of one standalone check: the value of its body, or a refusal before the legs. */
export type StandaloneCheckOutcome<T> = { readonly kind: 'ran'; readonly value: T } | { readonly kind: 'refused'; readonly reason: string };

/**
 * Run one approved check outside a dispatched operation, as the standalone test verb does. It has no store, so it claims, records and replays nothing.
 * The policy of each leg is the policy of {@link runApprovedCheck}. The working directory must be the root of a registered branch checkout.
 * No record binds the exact head, so the tree can have uncommitted changes, and a leg that changes the checkout keeps its result.
 */
export async function runStandaloneCheck<T>(request: StandaloneCheckRequest, body: (session: CheckSession) => Promise<T>): Promise<StandaloneCheckOutcome<T>> {
  const read = await observeWorkingDirectory({ checkout: request.checkout });
  if (read.kind === 'refused') return read;
  const legs: LegObservation[] = [];
  return { kind: 'ran', value: await body(liveSession(request.plan, read.checkout, read.checkout, legTimeout(request.legTimeoutMs), {}, legs)) };
}
