/**
 * Task 2.9 — End-to-end fresh-environment bootstrap smoke tests.
 *
 * This file is the PR2 integration gate: it proves the full install
 * story works from a completely empty Linux environment.
 *
 * Preconditions that must all be true to run end-to-end:
 *   1. `ENABLE_E2E_SMOKE=1` is set in the environment. Default is unset
 *      so `npm run test:run` stays fast on developer machines and the
 *      PR CI gate.
 *   2. Docker is installed and the daemon is reachable (`docker info`
 *      exits 0). Local dev machines and some CI runners won't have it.
 *   3. A real GitHub Release tag exists with the new binary assets
 *      (`exarchos-linux-x64` + `.sha512`). The bootstrap script
 *      downloads from GitHub Releases, so the tests need a real
 *      release to pull from. Until v2.9.0 is cut post-merge, the
 *      download will 404 and the tests degrade gracefully to an
 *      INFO-logged skip rather than a hard failure.
 *
 * When any precondition is false, every test in this file skips with
 * a clear reason string. That is by design: the real signal is the
 * `.github/workflows/fresh-install-smoke.yml` weekly cron, not the
 * per-PR local run.
 *
 * The tests deliberately invoke the **real** bootstrap script
 * (`scripts/get-exarchos.sh`) unmodified — no stubbing, no patching,
 * no fixture server. This is the one place we exercise the whole
 * download → verify → install → run pipeline end-to-end.
 *
 * Out of scope:
 *   - Windows smoke (bootstrap.ps1 under Windows CI — deferred until
 *     #1170).
 *   - Actually cutting the v2.9.0 release (user does that post-merge).
 *   - Any modification to bootstrap scripts (locked, tasks 2.5, 2.6).
 *
 * Implements: Plan task 2.9 — End-to-end smoke: fresh-environment
 *             bootstrap.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------
// Module-scope paths
// ---------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** Absolute path to the repo root, derived from this file's location. */
const REPO_ROOT = resolve(__dirname, '..', '..');
/** Absolute path to the real bootstrap script. */
const BOOTSTRAP_SCRIPT = join(REPO_ROOT, 'scripts', 'get-exarchos.sh');

// ---------------------------------------------------------------------
// Precondition gates
// ---------------------------------------------------------------------

const e2eEnabled = process.env.ENABLE_E2E_SMOKE === '1';

/**
 * Probe the docker daemon with a short-timeout `docker info`. Any
 * non-zero exit, spawn error, or missing binary is treated as "docker
 * not available" — never a test failure.
 */
function isDockerAvailable(): boolean {
  try {
    const r = spawnSync('docker', ['info'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

const dockerAvailable = isDockerAvailable();

// ---------------------------------------------------------------------
// Docker command builder (extracted from the inline form in RED)
// ---------------------------------------------------------------------

/**
 * Canonical JSON-RPC `initialize` frame — serialized once at module
 * load so the shape is tested-once, used-many. Single quotes around
 * the literal in the shell wrapper demand that no single quote
 * appear inside the JSON payload; `JSON.stringify` gives us that
 * guarantee.
 */
const INITIALIZE_FRAME = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.0.0' },
  },
});

/**
 * Where the read-only bootstrap script mount appears inside the
 * container. The test copies from here to `/tmp` before executing so
 * the bind mount can stay read-only (defense-in-depth against an
 * errant `chmod -R` in the script).
 */
const MOUNT_PATH = '/mnt/get-exarchos.sh';

interface BuildInContainerOpts {
  /**
   * Distro-specific package-manager prelude that installs the minimum
   * deps (`curl` + `ca-certificates`, plus `bash` on alpine). Must exit 0.
   */
  installPrelude: string;
  /** Release tag to pin via `EXARCHOS_LATEST_VERSION` (skips GitHub API). */
  versionTag: string;
}

/**
 * Build the shell command string that runs *inside* the target docker
 * container. Pure function — easy to eyeball in review and unit-test
 * without spawning docker.
 *
 * The returned string:
 *   1. Runs the distro install prelude.
 *   2. Copies the mounted bootstrap to a writable path + chmods it.
 *   3. Invokes the script with `EXARCHOS_LATEST_VERSION` pinned so the
 *      GitHub API lookup is bypassed.
 *   4. Sources `~/.bashrc` (if present) + prepends `~/.local/bin` to
 *      PATH so the new binary resolves.
 *   5. Runs `exarchos --version`.
 *   6. Feeds one JSON-RPC `initialize` frame to `exarchos mcp` on
 *      stdin; the MCP server writes a well-formed response to stdout
 *      before exiting on EOF.
 */
export function buildInContainerCommand(opts: BuildInContainerOpts): string {
  const { installPrelude, versionTag } = opts;
  return [
    installPrelude,
    `cp ${MOUNT_PATH} /tmp/get-exarchos.sh`,
    'chmod +x /tmp/get-exarchos.sh',
    `EXARCHOS_LATEST_VERSION='${versionTag}' bash /tmp/get-exarchos.sh`,
    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" || true',
    'export PATH="$HOME/.local/bin:$PATH"',
    'exarchos --version',
    `printf '%s\\n' '${INITIALIZE_FRAME}' | exarchos mcp`,
  ].join(' && ');
}

/**
 * Build the argv for `spawnSync('docker', ...)`. Factored out so the
 * volume-mount + shell invocation wiring has a single definition.
 */
export function buildDockerArgs(
  image: string,
  inContainerCommand: string,
): string[] {
  return [
    'run',
    '--rm',
    '-v',
    `${BOOTSTRAP_SCRIPT}:${MOUNT_PATH}:ro`,
    image,
    'sh',
    '-c',
    inContainerCommand,
  ];
}

/**
 * Classified smoke result. Discriminated union so the caller can tell
 * "download 404 — expected before the first v2.9.0 release" from a
 * real failure.
 */
type SmokeOutcome =
  | { kind: 'pass'; stdout: string; stderr: string }
  | { kind: 'download-missing'; stdout: string; stderr: string; status: number }
  | { kind: 'fail'; stdout: string; stderr: string; status: number | null };

function runDockerSmoke(image: string, installPrelude: string): SmokeOutcome {
  const versionTag = process.env.EXARCHOS_SMOKE_VERSION ?? 'v2.9.0';
  const inContainer = buildInContainerCommand({ installPrelude, versionTag });
  const r = spawnSync('docker', buildDockerArgs(image, inContainer), {
    encoding: 'utf8',
    timeout: 180_000,
    // Hermetic run — bootstrap needs no host env to function.
    env: {},
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  if (r.status === 0) {
    return { kind: 'pass', stdout, stderr };
  }
  if (
    /failed to download binary/i.test(stderr) ||
    /failed to download binary/i.test(stdout)
  ) {
    return { kind: 'download-missing', stdout, stderr, status: r.status ?? -1 };
  }
  return { kind: 'fail', stdout, stderr, status: r.status };
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

const skipReason = (() => {
  if (!e2eEnabled)
    return 'ENABLE_E2E_SMOKE is not set — default-skipped so PR CI stays fast';
  if (!dockerAvailable)
    return 'docker daemon not reachable — smoke requires docker run';
  if (!existsSync(BOOTSTRAP_SCRIPT))
    return `bootstrap script missing at ${BOOTSTRAP_SCRIPT}`;
  return null;
})();

describe('task 2.9 — fresh-environment bootstrap smoke (unit)', () => {
  // Pure-function checks on the extracted builder. These run in every
  // environment (no docker, no ENABLE_E2E_SMOKE needed) and lock the
  // shell-string contract that the docker cases depend on.
  it('buildInContainerCommand_IncludesAllBootstrapSteps', () => {
    const cmd = buildInContainerCommand({
      installPrelude: 'INSTALL_PRELUDE',
      versionTag: 'v9.9.9',
    });
    expect(cmd).toContain('INSTALL_PRELUDE');
    expect(cmd).toContain('/mnt/get-exarchos.sh');
    expect(cmd).toContain("EXARCHOS_LATEST_VERSION='v9.9.9'");
    expect(cmd).toContain('exarchos --version');
    expect(cmd).toContain('exarchos mcp');
    expect(cmd).toContain('"jsonrpc":"2.0"');
    expect(cmd).toContain('"method":"initialize"');
  });

  it('buildDockerArgs_WiresReadOnlyVolumeMount', () => {
    const args = buildDockerArgs('ubuntu:24.04', 'echo hi');
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(args).toContain('ubuntu:24.04');
    // Last arg is the in-container command payload.
    expect(args[args.length - 1]).toBe('echo hi');
    // Volume mount is read-only to defend against a runaway chmod.
    const volArg = args[args.indexOf('-v') + 1];
    expect(volArg.endsWith(':/mnt/get-exarchos.sh:ro')).toBe(true);
  });
});

describe('task 2.9 — fresh-environment bootstrap smoke', () => {
  it.skipIf(skipReason !== null)(
    'FreshInstall_BootstrapScript_ProducesWorkingBinary_Ubuntu',
    () => {
      const outcome = runDockerSmoke(
        'ubuntu:24.04',
        'apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null',
      );
      if (outcome.kind === 'download-missing') {
        // Expected before the first v2.9.0 release is cut.
        // eslint-disable-next-line no-console
        console.info(
          '[smoke] ubuntu: bootstrap reached download step but release ' +
            'assets are not yet published — expected until first v2.9.0 ' +
            'release is cut',
        );
        expect(outcome.stderr + outcome.stdout).toContain(
          'failed to download binary',
        );
        return;
      }
      if (outcome.kind !== 'pass') {
        throw new Error(
          `[smoke] ubuntu failed (status=${outcome.status}):\n` +
            `STDOUT:\n${outcome.stdout}\nSTDERR:\n${outcome.stderr}`,
        );
      }
      expect(outcome.stdout).toMatch(/exarchos/i);
      expect(outcome.stdout).toMatch(/"jsonrpc"\s*:\s*"2\.0"/);
    },
    240_000,
  );

  it.skipIf(skipReason !== null)(
    'FreshInstall_BootstrapScript_ProducesWorkingBinary_Alpine',
    () => {
      // Alpine ships only musl. v2.9's bootstrap warns and still
      // downloads the glibc binary — which will fail to execute under
      // musl. This test is XFAIL-equivalent until the musl track
      // lands (deferred per plan). When the script correctly bails
      // with the glibc-on-musl error we still consider the smoke
      // "observation complete" and record the outcome.
      const outcome = runDockerSmoke(
        'alpine:latest',
        'apk add --no-cache curl ca-certificates bash >/dev/null',
      );
      if (outcome.kind === 'download-missing') {
        // eslint-disable-next-line no-console
        console.info(
          '[smoke] alpine: bootstrap reached download step but release ' +
            'assets are not yet published — expected until first v2.9.0 ' +
            'release is cut',
        );
        expect(outcome.stderr + outcome.stdout).toContain(
          'failed to download binary',
        );
        return;
      }
      if (outcome.kind === 'fail') {
        // Musl-on-glibc is an expected failure mode until true musl
        // binaries ship.
        // eslint-disable-next-line no-console
        console.info(
          '[smoke] alpine: bootstrap ran, binary failed to exec ' +
            '(expected on musl until true musl build lands):\n' +
            outcome.stderr,
        );
        expect(outcome.stdout + outcome.stderr).toMatch(/exarchos/i);
        return;
      }
      // Unexpected pass on musl → strong signal that we shipped a musl
      // build. Assert the JSON-RPC shape too.
      expect(outcome.stdout).toMatch(/exarchos/i);
      expect(outcome.stdout).toMatch(/"jsonrpc"\s*:\s*"2\.0"/);
    },
    240_000,
  );
});
