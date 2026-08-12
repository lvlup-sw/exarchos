#!/usr/bin/env node
/**
 * check-mutation-gate — diff-scoped mutation-adequacy CI wrapper (task 004,
 * DR-7/DR-10; docs/specs/2026-07-17-wave-s-enforcement-substrate.md §DR-7).
 *
 * Invocation seam (documented per the task brief — read this before changing
 * it): the in-tree `mutation-adequacy` orchestrate action
 * (`servers/exarchos-mcp/src/verbs/gates/mutation-adequacy.ts`) is invoked
 * **in-process, through the real server entrypoint** (the same
 * `handleMutationAdequacy` function the MCP `exarchos_orchestrate` tool
 * dispatches to) rather than shelling out to a CLI or re-implementing its
 * logic. `handleMutationAdequacy` requires a real `EventStore`, and
 * `EventStore` (`servers/exarchos-mcp/src/events/store.ts`) unconditionally
 * pulls in the SQLite backend, which imports `bun:sqlite` — a virtual module
 * scheme only Bun's runtime resolves. Plain Node (and therefore `tsx`, which
 * still executes under Node) rejects it with `ERR_UNSUPPORTED_ESM_URL_SCHEME`
 * — the exact failure `src/events/cli-concurrency.test.ts`'s own history
 * comment documents for the same reason (issue #1324). `npx`/plain-node/tsx are
 * therefore all disqualified for this specific entrypoint; **Bun** is the one
 * runtime that resolves `bun:sqlite` natively, and this repo already requires
 * Bun as a first-class tool (`test-mcp`'s `compiled-binary-mcp.test.ts`,
 * `oven-sh/setup-bun@v2` already wired into that job, `npm run cli:vocab-guard`
 * via `bun run` at the repo root). So: a tiny bridge module — generated at
 * invocation time into the ephemeral work dir, never checked in, so this file
 * stays the sole on-disk artifact per the task's file list — imports
 * `handleMutationAdequacy` + `EventStore` by absolute path and is executed via
 * `bun run` (never `npx`, matching the repo-wide stryker-adapter.mjs
 * precedent). The bridge's stdout carries the handler's JSON `ToolResult`
 * between two markers; everything else (pino logs go to fd 2, per
 * `src/logger.ts`) is noise this script ignores.
 *
 * Skip/failure taxonomy (DR-7, exact):
 *   - non-`pull_request` GH event               → logged SKIP, exit 0.
 *   - server-scoped diff (`servers/exarchos-mcp/src/**`) is empty  → logged
 *     SKIP, exit 0. Computed by THIS script before the handler is ever
 *     invoked (cheap, and lets the two skip reasons stay exhaustive and
 *     attributable independent of what the handler itself would have done).
 *   - EVERY other outcome is not a skip. In particular:
 *       - a git failure (can't resolve/fetch the base ref, `git diff` itself
 *         fails) is FAIL CLOSED, never folded into the empty-diff skip;
 *       - a missing/unusable `bun` binary is FAIL CLOSED (tool-missing);
 *       - a scored verdict below threshold, or NoCoverage over its budget
 *         (DR-6 axis), is a FAILURE;
 *       - a DEGRADE-without-verdict (runner crash, unparseable report) is a
 *         FAILURE once blocking — keyed off `data.warning` / `data.skipped` /
 *         `data.degraded` on the returned carrier, **never `passed` alone**:
 *         the handler's degrade paths return `success:true, data.passed:true`
 *         as a warning carrier (see mutation-adequacy.ts `warningCarrier` and
 *         the no-toolchain skip-pass branch) — trusting `passed` here would
 *         silently let every degrade/skip class through as a pass.
 *   `--observe` (the DR-7 soak-window flag): the same verdict is computed and
 *   logged, but the process ALWAYS exits 0 (task 007 wires this in observe
 *   mode; task 009 flips to blocking). The two logged skips still exit 0
 *   regardless of `--observe` (they were never a blocking verdict to begin
 *   with — observe only softens verdicts, not the skip taxonomy).
 *
 * Exit codes (blocking mode; `--observe` collapses all of these to 0 except
 * the two skips, which are always 0):
 *   0 — pass, or a logged skip.
 *   1 — gate failure (score/NoCoverage axis, or a degrade/skip marker).
 *   2 — fail-closed (git failure, missing tooling, unparseable bridge output).
 *
 * Flags (all optional; production usage in CI needs none beyond `--observe`
 * — the rest default from the GitHub Actions environment):
 *   --observe                 Soak-window mode: log the verdict, always exit 0.
 *   --event-name <name>       Override `GITHUB_EVENT_NAME`. Default: env var.
 *   --base <ref>              Override `GITHUB_BASE_REF`. Default: env var.
 *   --head <ref>              Default 'HEAD'.
 *   --remote <name>           Remote to fetch the base ref from. Default 'origin'.
 *   --repo-root <path>        Target repo for diffing + `.exarchos.yml`
 *                             resolution. Default: this checkout's root
 *                             (derived from this script's own location, NOT
 *                             `process.cwd()` — robust to a job's
 *                             `working-directory:` default).
 *   --bun-bin <path>          Bun executable to invoke. Default 'bun' (PATH).
 *   --help                    Show usage.
 *
 * Self-test: scripts/check-mutation-gate.test.sh (self-contained fixture git
 * repos — no network, no real Stryker run; see its own header).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** This checkout's root — always where the real handler code lives (the
 * "server entrypoint"), independent of `--repo-root` (the diffed/target repo,
 * which in production is the SAME checkout, but in the self-test is a
 * throwaway fixture repo). */
const EXARCHOS_ROOT = path.resolve(SCRIPT_DIR, '..');
const SERVER_DIR = path.join(EXARCHOS_ROOT, 'servers', 'exarchos-mcp');
const MUTATION_ADEQUACY_ENTRY = path.join(SERVER_DIR, 'src', 'orchestrate', 'mutation-adequacy.ts');
const EVENT_STORE_ENTRY = path.join(SERVER_DIR, 'src', 'event-store', 'store.ts');

/** Repo-root-relative prefix this gate diff-scopes to (DR-7). */
const SERVER_SRC_SCOPE = path.posix.join('servers', 'exarchos-mcp', 'src');

const EXIT_PASS = 0;
const EXIT_GATE_FAILED = 1;
const EXIT_FAILCLOSED = 2;

// Bounded deadlines (ms) for every subprocess this gate spawns. A stalled git
// fetch, an unresponsive `bun` probe, or a wedged mutation runner must never
// hang the CI job indefinitely — spawnSync's `timeout` kills the child and
// populates `result.error` (code `ETIMEDOUT`), which every call site below
// already routes to a FAIL-CLOSED path (DR-10: a deadline expiry is an
// attributable fail-closed, never a silent block).
const GIT_TIMEOUT_MS = 120_000; // includes the network-backed base-ref fetch
const BUN_PROBE_TIMEOUT_MS = 30_000; // `bun --version` availability probe
const MUTATION_RUN_TIMEOUT_MS = 20 * 60_000; // the bun-run mutation invocation

const RESULT_START_MARKER = '<<<CHECK_MUTATION_GATE_RESULT_START>>>';
const RESULT_END_MARKER = '<<<CHECK_MUTATION_GATE_RESULT_END>>>';

class GateFailed extends Error {}
class FailClosed extends Error {}

// ── CLI ──────────────────────────────────────────────────────────────────────

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

// ── git helpers (fail-closed on any git failure; never throw) ───────────────

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
 * Resolve `base` to a diffable ref. If it already resolves locally (a SHA, a
 * local branch, or anything the self-test's own fixture repo already has),
 * use it verbatim — no network. Otherwise `git fetch <remote> <base>` (the
 * CI checkout is shallow, per DR-7 — this is the "fetch the PR base ref
 * explicitly" step) and diff against the resulting `FETCH_HEAD`. A fetch
 * failure is a git failure (FAIL CLOSED), distinct from a diff that succeeds
 * and is merely empty.
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
 * The preflight diff scopes `base...args.head`, but the handler bridge mutates
 * the WORKING TREE (whatever is checked out at `HEAD`) — it is not given
 * `args.head`. If `--head` resolves to a commit OTHER than the checkout's
 * `HEAD`, the gate would compute its diff scope from one change set but score a
 * DIFFERENT one. Resolve both to SHAs and fail closed on a mismatch (DR-10):
 * in production `--head` defaults to `HEAD`, so this is a guard, not a
 * behaviour change. Returns `{ ok }` or `{ ok:false, reason }` — never throws.
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

/** `git diff --name-only <base>...<head> -- servers/exarchos-mcp/src`. */
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

// ── bridge (generated at invocation time; bun-executed) ─────────────────────

/**
 * Source for the ephemeral bridge module `bun run` executes. Imports the real
 * handler + EventStore by absolute path (so it works regardless of the
 * bridge file's own temp location), constructs a throwaway EventStore against
 * the ephemeral state dir, invokes the handler with the fixed CI featureId,
 * and prints the JSON `ToolResult` between stdout markers. Any thrown error
 * is caught and reported on stderr with a non-zero exit — this script treats
 * that as FAIL CLOSED (never a silent pass).
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
 * Run the handler bridge under Bun in an ephemeral work dir (bridge module +
 * EventStore's SQLite state file), returning the parsed `ToolResult`. The
 * whole work dir is removed afterward — "emitted events are discarded" (DR-7):
 * only the exit code / verdict this function derives from stdout survives.
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
    // EventStore's SQLite backend creates its own file under stateDir; the
    // directory itself must pre-exist. mkdtempSync above only made workDir.
    // Use a subdirectory of workDir that we create explicitly so a stray
    // leftover from a previous run can never be mistaken for a fresh one.
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

// ── verdict ───────────────────────────────────────────────────────────────

/**
 * Key failure off the DEGRADE/SKIP markers, never `passed` alone (DR-7): the
 * handler's degrade paths (`warningCarrier`) and its no-toolchain skip-pass
 * both return `success:true, data.passed:true` — a warning carrier, not a
 * verifiable pass. `result.success === false` (a hard handler error, e.g.
 * INVALID_INPUT) is also a failure — there is no verdict to trust either way.
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
  // Past every degrade/skip marker, the ONLY carriers left are real scored
  // runs — which the handler always emits with finite numeric axes
  // (mutation-adequacy.ts §INV-5b carrier). A carrier claiming to be a clean
  // scored pass but MISSING those fields (`ToolResult.data` is `unknown`, so
  // `{ success:true, data:{ passed:true } }` would otherwise sail through and
  // log `undefined` metrics as a pass) is malformed — fail closed rather than
  // trust an unverifiable verdict (DR-10). Placed AFTER the degrade guards on
  // purpose: warning/skip/deferred carriers legitimately omit
  // threshold/maxNoCoverage and are already caught above with their own,
  // more-specific reasons.
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

// ── main ─────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  // ── skip 1: non-PR event ───────────────────────────────────────────────
  if (args.eventName !== 'pull_request') {
    process.stdout.write(
      `check-mutation-gate: SKIP — event '${args.eventName ?? '(unset)'}' is not 'pull_request'; ` +
        'the diff-scoped mutation gate only runs on PR events\n',
    );
    process.exit(EXIT_PASS);
  }

  if (!args.base) {
    // Not one of the two logged skips — a pull_request event with no base ref
    // is an environment fault (GITHUB_BASE_REF unset), not a legitimate skip.
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

    // ── skip 2: empty server-scoped diff ─────────────────────────────────
    if (diff.files.length === 0) {
      process.stdout.write(
        `check-mutation-gate: SKIP — the ${resolvedBase.ref}...${args.head} diff touches no files under ` +
          `${SERVER_SRC_SCOPE}/**; nothing to mutation-gate\n`,
      );
      process.exit(EXIT_PASS);
    }

    // The handler mutates the checked-out working tree, not `args.head`. Refuse
    // to run if `--head` names a different commit than HEAD, so the scored
    // change set is always the one the diff scope was computed from (DR-10).
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
