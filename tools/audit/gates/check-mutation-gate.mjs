#!/usr/bin/env node
/**
 * check-mutation-gate: the diff-scoped mutation-adequacy CI wrapper. It calls the real
 * `handleMutationAdequacy` handler through a bridge module that it writes to a temp directory
 * and runs with `bun run`. The handler needs an `EventStore`, which imports `bun:sqlite`, and
 * only Bun resolves that module. Node and `tsx` fail with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
 *
 * Skips (exit 0): a non-`pull_request` event, and a `src/**` diff with no files.
 * Exit 1: a score below threshold, NoCoverage over budget, a hard handler error, or a degrade
 * or skip marker on the result. The gate never trusts `data.passed` alone.
 * Exit 2: fail closed on a missing base ref, a git failure, an unusable `bun`, or bad bridge output.
 * With `--observe`, a gate failure or a fail-closed condition is logged, and the exit is 0.
 *
 * Flags: `--observe`, `--event-name`, `--base`, `--head`, `--remote`, `--repo-root`, `--bun-bin`.
 * The defaults come from the GitHub Actions environment.
 * Self-test: `tests/scripts/check-mutation-gate.test.sh`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/**
 * The root of this checkout, where the handler code lives. `--repo-root` names the diffed
 * repo, which is this checkout in production and a fixture repo in the self-test.
 */
const EXARCHOS_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const SERVER_DIR = path.join(EXARCHOS_ROOT);
const MUTATION_ADEQUACY_ENTRY = path.join(SERVER_DIR, 'src', 'verbs', 'gates', 'mutation-adequacy.ts');
const EVENT_STORE_ENTRY = path.join(SERVER_DIR, 'src', 'events', 'store.ts');

/** The repo-relative prefix that scopes the diff. */
const SERVER_SRC_SCOPE = path.posix.join('src');

const EXIT_PASS = 0;
const EXIT_GATE_FAILED = 1;
const EXIT_FAILCLOSED = 2;

/**
 * Deadline in ms for each git call, the network fetch of the base ref included. Each subprocess
 * has a deadline. A timeout sets `result.error` to `ETIMEDOUT`, and each call site fails closed.
 */
const GIT_TIMEOUT_MS = 120_000;
/** Deadline in ms for the `bun --version` probe. */
const BUN_PROBE_TIMEOUT_MS = 30_000;
/** Deadline in ms for the `bun run` mutation invocation. */
const MUTATION_RUN_TIMEOUT_MS = 20 * 60_000;

const RESULT_START_MARKER = '<<<CHECK_MUTATION_GATE_RESULT_START>>>';
const RESULT_END_MARKER = '<<<CHECK_MUTATION_GATE_RESULT_END>>>';

class GateFailed extends Error {}
class FailClosed extends Error {}

function printUsage() {
  process.stderr.write(
    'Usage: check-mutation-gate.mjs [--observe] [--event-name <name>] [--base <ref>]\n' +
      '  [--head <ref>] [--remote <name>] [--repo-root <path>] [--bun-bin <path>] [--help]\n',
  );
}

function usageFail(msg) {
  process.stderr.write(`check-mutation-gate: ${msg}\n`);
  printUsage();
  process.exit(EXIT_FAILCLOSED);
}

function parseArgs(argv) {
  const args = {
    observe: false,
    eventName: process.env.GITHUB_EVENT_NAME,
    base: process.env.GITHUB_BASE_REF,
    head: 'HEAD',
    remote: 'origin',
    repoRoot: EXARCHOS_ROOT,
    bunBin: 'bun',
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(EXIT_PASS);
    } else if (arg === '--observe') {
      args.observe = true;
    } else if (arg === '--event-name') {
      const value = argv[++i];
      if (!value) usageFail('--event-name requires a value');
      args.eventName = value;
    } else if (arg === '--base') {
      const value = argv[++i];
      if (!value) usageFail('--base requires a value');
      args.base = value;
    } else if (arg === '--head') {
      const value = argv[++i];
      if (!value) usageFail('--head requires a value');
      args.head = value;
    } else if (arg === '--remote') {
      const value = argv[++i];
      if (!value) usageFail('--remote requires a value');
      args.remote = value;
    } else if (arg === '--repo-root') {
      const value = argv[++i];
      if (!value) usageFail('--repo-root requires a path');
      args.repoRoot = path.resolve(value);
    } else if (arg === '--bun-bin') {
      const value = argv[++i];
      if (!value) usageFail('--bun-bin requires a path');
      args.bunBin = value;
    } else {
      usageFail(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/** Runs git with a deadline. Returns `{ ok, stdout, detail }` and never throws. */
function runGit(repoRoot, gitArgs) {
  const result = spawnSync('git', gitArgs, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (result.error) {
    const detail =
      result.error.code === 'ETIMEDOUT'
        ? `git ${gitArgs.join(' ')} exceeded the ${GIT_TIMEOUT_MS}ms deadline`
        : result.error.message;
    return { ok: false, stdout: '', detail };
  }
  if (result.status !== 0) {
    return { ok: false, stdout: result.stdout ?? '', detail: (result.stderr || result.stdout || '').trim() };
  }
  return { ok: true, stdout: result.stdout ?? '', detail: '' };
}

/**
 * Resolves `base` to a diffable ref. A ref that resolves locally is used as is, with no network.
 * Otherwise it runs `git fetch <remote> <base>`, because the CI checkout is shallow, and uses
 * `FETCH_HEAD`. A fetch failure fails closed, and it is not an empty diff.
 */
function resolveBaseRef(repoRoot, remote, base) {
  const verify = runGit(repoRoot, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (verify.ok) return { ok: true, ref: base };

  const fetch = runGit(repoRoot, ['fetch', remote, base]);
  if (!fetch.ok) {
    return {
      ok: false,
      reason: `git fetch ${remote} ${base} failed (base ref unresolvable locally and unfetchable): ${fetch.detail}`,
    };
  }
  return { ok: true, ref: 'FETCH_HEAD' };
}

/**
 * The diff uses `base...head`, but the bridge mutates the working tree at `HEAD`. When `--head`
 * names another commit, the gate scores a change set that it did not scope, so it fails closed.
 * Returns `{ ok }` or `{ ok: false, reason }` and never throws.
 */
function assertHeadIsCheckout(repoRoot, head) {
  const headSha = runGit(repoRoot, ['rev-parse', '--verify', `${head}^{commit}`]);
  if (!headSha.ok) {
    return { ok: false, reason: `could not resolve --head '${head}' to a commit: ${headSha.detail}` };
  }
  const checkoutSha = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!checkoutSha.ok) {
    return { ok: false, reason: `could not resolve the checkout's HEAD to a commit: ${checkoutSha.detail}` };
  }
  const resolvedHead = headSha.stdout.trim();
  const resolvedCheckout = checkoutSha.stdout.trim();
  if (resolvedHead !== resolvedCheckout) {
    return {
      ok: false,
      reason:
        `--head '${head}' (${resolvedHead.slice(0, 12)}) does not resolve to the checked-out HEAD ` +
        `(${resolvedCheckout.slice(0, 12)}); the mutation handler mutates the working tree at HEAD, so ` +
        `evaluating a different --head would score the wrong change set — refusing to run`,
    };
  }
  return { ok: true };
}

/** `git diff --name-only <base>...<head> -- src`. */
function diffServerScope(repoRoot, base, head) {
  const diff = runGit(repoRoot, ['diff', '--name-only', `${base}...${head}`, '--', SERVER_SRC_SCOPE]);
  if (!diff.ok) {
    return { ok: false, reason: `git diff ${base}...${head} -- ${SERVER_SRC_SCOPE} failed: ${diff.detail}` };
  }
  const files = diff.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { ok: true, files };
}

/**
 * Source for the temp bridge module that `bun run` executes. It imports the handler and
 * `EventStore` by absolute path, opens a throwaway store in the temp state directory, and calls
 * the handler. It prints the JSON `ToolResult` between stdout markers. A thrown error goes to
 * stderr with exit 1, and the gate then fails closed.
 */
function buildBridgeSource() {
  return `
import { handleMutationAdequacy } from ${JSON.stringify(MUTATION_ADEQUACY_ENTRY)};
import { EventStore } from ${JSON.stringify(EVENT_STORE_ENTRY)};

const args = JSON.parse(process.env.CHECK_MUTATION_GATE_ARGS ?? '{}');

try {
  const store = new EventStore(args.stateDir);
  await store.initialize();
  const result = await handleMutationAdequacy(
    { featureId: args.featureId, base: args.base, repoRoot: args.repoRoot },
    args.stateDir,
    store,
  );
  process.stdout.write(${JSON.stringify(RESULT_START_MARKER)} + "\\n");
  process.stdout.write(JSON.stringify(result));
  process.stdout.write("\\n" + ${JSON.stringify(RESULT_END_MARKER)} + "\\n");
  process.exit(0);
} catch (err) {
  process.stderr.write('check-mutation-gate bridge: handler invocation threw: ' + (err && err.stack ? err.stack : String(err)) + "\\n");
  process.exit(1);
}
`;
}

/**
 * Runs the bridge under Bun in a temp work directory and returns the parsed `ToolResult`.
 * It deletes the work directory after the run, so the emitted events are discarded.
 * The SQLite backend needs its state directory to exist, so the function creates a fresh one.
 */
function invokeHandlerViaBun(bunBin, repoRoot, base) {
  const versionCheck = spawnSync(bunBin, ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: BUN_PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (versionCheck.error || versionCheck.status !== 0) {
    const detail = versionCheck.error
      ? versionCheck.error.code === 'ETIMEDOUT'
        ? `bun --version exceeded the ${BUN_PROBE_TIMEOUT_MS}ms deadline`
        : versionCheck.error.message
      : (versionCheck.stderr || '').trim();
    throw new FailClosed(
      `bun executable ${JSON.stringify(bunBin)} is not usable (required to invoke the mutation-adequacy ` +
        `handler through a real EventStore — bun:sqlite only resolves under Bun, see this script's header): ${detail}`,
    );
  }

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'check-mutation-gate-'));
  try {
    const bridgePath = path.join(workDir, 'bridge.mts');
    const stateDir = path.join(workDir, 'state');
    writeFileSync(bridgePath, buildBridgeSource());
    mkdirSync(stateDir, { recursive: true });

    const bridgeArgs = {
      featureId: 'ci-mutation-gate',
      base,
      repoRoot,
      stateDir,
    };

    const run = spawnSync(bunBin, ['run', bridgePath], {
      cwd: SERVER_DIR,
      encoding: 'utf-8',
      env: { ...process.env, CHECK_MUTATION_GATE_ARGS: JSON.stringify(bridgeArgs) },
      timeout: MUTATION_RUN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    if (run.error) {
      if (run.error.code === 'ETIMEDOUT') {
        throw new FailClosed(
          `bun run ${bridgePath} exceeded the ${MUTATION_RUN_TIMEOUT_MS}ms mutation-run deadline ` +
            `(a stalled runner was killed rather than left to hang CI)`,
        );
      }
      throw new FailClosed(`bun run ${bridgePath} failed to launch: ${run.error.message}`);
    }

    const stdout = run.stdout ?? '';
    const startIdx = stdout.indexOf(RESULT_START_MARKER);
    const endIdx = stdout.indexOf(RESULT_END_MARKER);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
      throw new FailClosed(
        `bridge produced no parseable result markers (bun exit ${run.status}); stderr: ` +
          `${(run.stderr || '').trim().slice(0, 2000) || '(empty)'}`,
      );
    }
    const jsonSlice = stdout.slice(startIdx + RESULT_START_MARKER.length, endIdx).trim();
    let parsed;
    try {
      parsed = JSON.parse(jsonSlice);
    } catch (err) {
      throw new FailClosed(`bridge result was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parsed;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Fails on the degrade and skip markers, never on `passed` alone. The degrade and no-toolchain
 * paths of the handler return `success: true` and `data.passed: true` as a warning carrier.
 * A hard handler error also fails. After the marker checks, a result needs a boolean `passed` and
 * finite `mutationScore`, `threshold`, `noCoverage` and `maxNoCoverage`, or it fails closed.
 * The marker checks come first, because degrade carriers omit those fields.
 */
function computeVerdict(result) {
  if (!result || typeof result !== 'object') {
    throw new FailClosed('bridge result was not a JSON object');
  }
  if (result.success !== true) {
    const message = result.error && result.error.message ? result.error.message : JSON.stringify(result);
    throw new GateFailed(`mutation-adequacy handler returned a hard failure: ${message}`);
  }
  const data = result.data;
  if (!data || typeof data !== 'object') {
    throw new FailClosed('bridge result carried no data payload');
  }
  if (data.warning !== undefined) {
    throw new GateFailed(`mutation-adequacy degraded (no verifiable verdict): ${data.warning}`);
  }
  if (data.skipped === true) {
    throw new GateFailed(
      `mutation-adequacy could not run (skipped: ${data.reason ?? '(no reason given)'}) — a CI PR diff touching ` +
        `server sources requires a working mutation toolchain; treating an unresolved/degraded runner as a ` +
        `failure rather than a silent pass`,
    );
  }
  if (data.degraded === true) {
    throw new GateFailed(`mutation-adequacy degraded (no verifiable verdict): ${data.reason ?? '(no reason given)'}`);
  }
  const hasVerdict =
    typeof data.passed === 'boolean' &&
    Number.isFinite(data.mutationScore) &&
    Number.isFinite(data.threshold) &&
    Number.isFinite(data.noCoverage) &&
    Number.isFinite(data.maxNoCoverage);
  if (!hasVerdict) {
    throw new FailClosed(
      'bridge result carried an invalid mutation verdict (a non-degrade carrier without finite ' +
        'passed/mutationScore/threshold/noCoverage/maxNoCoverage axes)',
    );
  }
  if (data.passed !== true) {
    throw new GateFailed(
      `mutation-adequacy FAILED — mutationScore ${data.mutationScore} (threshold ${data.threshold}), ` +
        `noCoverage ${data.noCoverage} (budget ${data.maxNoCoverage})` +
        (data.noCoverageReason ? `: ${data.noCoverageReason}` : ''),
    );
  }
  return data;
}

/** A `pull_request` event with no base ref is an environment fault, so it fails closed and is not a skip. */
function main() {
  const args = parseArgs(process.argv);

  if (args.eventName !== 'pull_request') {
    process.stdout.write(
      `check-mutation-gate: SKIP — event '${args.eventName ?? '(unset)'}' is not 'pull_request'; ` +
        'the diff-scoped mutation gate only runs on PR events\n',
    );
    process.exit(EXIT_PASS);
  }

  if (!args.base) {
    process.stderr.write(
      'check-mutation-gate: FAIL CLOSED — no base ref (GITHUB_BASE_REF unset and --base not given) on a ' +
        "pull_request event; cannot compute the diff\n",
    );
    process.exit(args.observe ? EXIT_PASS : EXIT_FAILCLOSED);
  }

  try {
    const resolvedBase = resolveBaseRef(args.repoRoot, args.remote, args.base);
    if (!resolvedBase.ok) {
      throw new FailClosed(resolvedBase.reason);
    }

    const diff = diffServerScope(args.repoRoot, resolvedBase.ref, args.head);
    if (!diff.ok) {
      throw new FailClosed(diff.reason);
    }

    if (diff.files.length === 0) {
      process.stdout.write(
        `check-mutation-gate: SKIP — the ${resolvedBase.ref}...${args.head} diff touches no files under ` +
          `${SERVER_SRC_SCOPE}/**; nothing to mutation-gate\n`,
      );
      process.exit(EXIT_PASS);
    }

    const headCheck = assertHeadIsCheckout(args.repoRoot, args.head);
    if (!headCheck.ok) {
      throw new FailClosed(headCheck.reason);
    }

    process.stdout.write(
      `check-mutation-gate: diff touches ${diff.files.length} file(s) under ${SERVER_SRC_SCOPE}/** — ` +
        'invoking mutation-adequacy\n',
    );

    const result = invokeHandlerViaBun(args.bunBin, args.repoRoot, resolvedBase.ref);
    const data = computeVerdict(result);
    process.stdout.write(
      `check-mutation-gate: PASS — mutationScore ${data.mutationScore} (threshold ${data.threshold}), ` +
        `noCoverage ${data.noCoverage} (budget ${data.maxNoCoverage})${data.trivialPass ? ' [trivial pass — empty mutatable surface]' : ''}\n`,
    );
    process.exit(EXIT_PASS);
  } catch (err) {
    if (err instanceof GateFailed) {
      if (args.observe) {
        process.stdout.write(
          `check-mutation-gate: OBSERVE — would FAIL blocking mode (soak window, not enforced): ${err.message}\n`,
        );
        process.exit(EXIT_PASS);
      }
      process.stderr.write(`check-mutation-gate: FAIL — ${err.message}\n`);
      process.exit(EXIT_GATE_FAILED);
    }
    if (err instanceof FailClosed) {
      if (args.observe) {
        process.stdout.write(
          `check-mutation-gate: OBSERVE — a fail-closed condition was encountered (soak window, not enforced): ${err.message}\n`,
        );
        process.exit(EXIT_PASS);
      }
      process.stderr.write(`check-mutation-gate: FAIL CLOSED — ${err.message}\n`);
      process.exit(EXIT_FAILCLOSED);
    }
    throw err;
  }
}

main();
