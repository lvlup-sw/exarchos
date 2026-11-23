/**
 * Check executors for gate tests. Each one answers the approved legs of a request with no claim.
 * The fake executors run each leg in its working directory with no Git check. The image executor answers each leg from a real disposable source image.
 *
 * A gate test reads only the interpretation of its legs. The real executor has its own tests and its own process proof.
 * The module imports the executor module only at run time, so a mock factory of that module can import it.
 */
import type { ApprovedCheckRequest, CheckExecutor, LegObservation, LegRequest } from '../../../src/verbs/verification/check-executor.js';
import type { CommandResult, RunCommandFn } from '../../../src/verbs/pure/static-analysis.js';
import { spawnAsync } from '../../../tools/test-helpers/spawn.js';

/** The argv of one leg request, from the approved plan of the request. */
async function argvOf(request: ApprovedCheckRequest, leg: LegRequest): Promise<readonly string[]> {
  const { legArgv } = await import('../../../src/verbs/verification/check-executor.js');
  return legArgv(request.plan, leg);
}

/** The leg observation of one runner result. A runner code maps to the end that the real executor gives for it. */
export function observationOf(argv: readonly string[], result: CommandResult): LegObservation {
  const output = { argv: [...argv], stdout: result.stdout, stderr: result.stderr };
  if (result.spawnError === 'ETIMEDOUT') return { ...output, end: 'timeout', exitCode: null };
  if (result.spawnError === 'ENOBUFS') return { ...output, end: 'output-limit', exitCode: null };
  if (result.spawnError !== undefined) return { ...output, end: 'unavailable', exitCode: null, code: result.spawnError, detail: result.stderr };
  if (result.signal !== undefined) return { ...output, end: 'signal', exitCode: null, signal: result.signal };
  return { ...output, end: 'exited', exitCode: result.exitCode };
}

/** A fake executor and the requests and legs that it received, in order. */
export interface FakeExecutor {
  readonly executor: CheckExecutor;
  readonly requests: ApprovedCheckRequest[];
  readonly legs: (readonly string[])[];
}

/** An executor that answers each leg with `run` in the working directory of the request. A refusal reason refuses every request. */
function executorOver(run: (argv: readonly string[], cwd: string) => Promise<LegObservation>, refusal?: string): FakeExecutor {
  const requests: ApprovedCheckRequest[] = [];
  const legs: (readonly string[])[] = [];
  const executor: CheckExecutor = async (request, body) => {
    requests.push(request);
    if (refusal !== undefined) return { kind: 'refused', reason: refusal };
    const value = await body({
      root: request.checkout,
      replayed: false,
      async run(leg) {
        const argv = await argvOf(request, leg);
        legs.push(argv);
        return run(argv, request.checkout);
      },
    });
    return { kind: 'ran', value, replayed: false, attempt: 1, observation: '0'.repeat(64) };
  };
  return { executor, requests, legs };
}

/** An executor that runs each leg through a synchronous `runner`. A refusal reason refuses every request. */
export function fakeExecutor(runner: RunCommandFn, refusal?: string): FakeExecutor {
  return executorOver(async (argv, cwd) => {
    const [program = '', ...args] = argv;
    return observationOf(argv, runner(program, args, { cwd }));
  }, refusal);
}

/** Start one leg as a real asynchronous child in `cwd`, and read its end as the real executor does. */
async function spawnLegIn(argv: readonly string[], cwd: string): Promise<LegObservation> {
  const [program = '', ...args] = argv;
  const result = await spawnAsync(program, args, { cwd });
  const output = { argv: [...argv], stdout: String(result.stdout), stderr: String(result.stderr) };
  if (result.error !== undefined && result.status === null && result.signal === null) {
    const code = 'code' in result.error && typeof result.error.code === 'string' ? result.error.code : undefined;
    return { ...output, end: 'unavailable', exitCode: null, detail: result.error.message, ...(code === undefined ? {} : { code }) };
  }
  if (result.status === null) return { ...output, end: 'signal', exitCode: null, ...(result.signal === null ? {} : { signal: result.signal }) };
  return { ...output, end: 'exited', exitCode: result.status };
}

/**
 * An executor that starts each leg as a real asynchronous child, with no confinement.
 * A request with a revert runs each leg in its real source image, as the local executor does. Each other leg runs in the working directory.
 */
export function spawningExecutor(): FakeExecutor {
  const plain = executorOver(spawnLegIn);
  const images = imageExecutor(({ argv, root }) => spawnLegIn(argv, root));
  const executor: CheckExecutor = (request, body) => request.revert === undefined ? plain.executor(request, body) : images.executor(request, body);
  return { executor, requests: plain.requests, legs: plain.legs };
}

/** One leg that an image executor answers: its argv, the operands that the gate appended, its source image and the root of that image. */
export interface ImageLeg {
  readonly argv: readonly string[];
  readonly append: readonly string[];
  readonly image: 'head' | 'reverted';
  readonly root: string;
}

/** An image executor and the requests that it received, in order. */
export interface ImageExecutor {
  readonly executor: CheckExecutor;
  readonly requests: ApprovedCheckRequest[];
}

/**
 * An executor that builds the real source image of each leg from the observed checkout, then answers the leg from that image with no process.
 * The reverted image takes the revert of the request. Each image goes after its answer. It binds no claim, so a case reads only the probe logic.
 */
export function imageExecutor(answer: (leg: ImageLeg) => LegObservation | Promise<LegObservation>): ImageExecutor {
  const requests: ApprovedCheckRequest[] = [];
  const executor: CheckExecutor = async (request, body) => {
    requests.push(request);
    const { processObservationalGitPath } = await import('../../../src/utils/git-tree.js');
    const { observeCurrentCheckout } = await import('../../../src/verbs/gates/gate-utils.js');
    const { buildDisposableCopy } = await import('../../../src/verbs/verification/disposable-copy.js');
    const gitPath = processObservationalGitPath();
    if (gitPath === undefined) throw new Error('No Git on PATH');
    const observed = await observeCurrentCheckout(gitPath, request.checkout);
    if (observed.kind === 'refused') return { kind: 'refused', reason: observed.reason };
    const { checkout } = observed;
    const source = { checkout: checkout.checkout, gitDir: checkout.gitDir, repository: checkout.repository, head: checkout.head,
      reads: observed.observer.reads };
    const value = await body({
      root: checkout.checkout,
      replayed: false,
      async run(leg) {
        const argv = await argvOf(request, leg);
        const image = leg.image ?? 'head';
        const copy = await buildDisposableCopy(source, image === 'reverted' ? request.revert : undefined);
        try {
          return { ...await answer({ argv, append: leg.append ?? [], image, root: copy.root }), ...(image === 'reverted' ? { image } : {}) };
        } finally {
          await copy.dispose();
        }
      },
    });
    return { kind: 'ran', value, replayed: false, attempt: 1, observation: '0'.repeat(64) };
  };
  return { executor, requests };
}

/** The observation of a leg that exited with `exitCode` and wrote nothing. */
export function exitedWith(argv: readonly string[], exitCode: number): LegObservation {
  return { argv: [...argv], end: 'exited', exitCode, stdout: '', stderr: '' };
}

