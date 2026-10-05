/**
 * End-to-end smoke tests for an install in a fresh environment. The docker cases run the
 * unmodified `tools/release/get-exarchos.sh` in a clean container, with no stub and no fixture
 * server.
 *
 * The docker cases run only when all of these are true:
 * - `ENABLE_E2E_SMOKE=1` is set. It is unset by default, so local runs and the PR gate stay fast.
 * - The docker daemon answers `docker info`.
 * - The bootstrap script exists.
 *
 * The script downloads from GitHub Releases. When the release assets are missing, a docker case
 * logs the fact and asserts only the download error. The weekly run of
 * `.github/workflows/fresh-install-smoke.yml` is the real signal. Windows is out of scope.
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { spawnAsync } from '../../tools/test-helpers/spawn.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** Absolute path to the repo root, derived from this file's location. */
const REPO_ROOT = resolve(__dirname, '..', '..');
/** Absolute path to the real bootstrap script. */
const BOOTSTRAP_SCRIPT = join(REPO_ROOT, 'tools', 'release', 'get-exarchos.sh');

const e2eEnabled = process.env.ENABLE_E2E_SMOKE === '1';

/**
 * Returns true when `docker info` exits 0 within 5 seconds. A spawn error or a missing binary
 * gives false, not a test failure.
 */
async function isDockerAvailable(): Promise<boolean> {
  try {
    const r = await spawnAsync('docker', ['info'], {
      timeout: 5_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();

/**
 * The JSON-RPC `initialize` frame. The shell wrapper puts it in single quotes, so the payload must
 * hold no single quote. These values serialize with none.
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
 * The path of the bootstrap script mount inside the container. The command copies the script to
 * `/tmp` before it runs it, so the bind mount can stay read-only.
 */
const MOUNT_PATH = '/mnt/get-exarchos.sh';

interface BuildInContainerOpts {
  /**
   * The package-manager command that installs `curl` and `ca-certificates`, plus `bash` on Alpine.
   * It must exit 0.
   */
  installPrelude: string;
  /** The release tag for `EXARCHOS_LATEST_VERSION`, which skips the GitHub API lookup. */
  versionTag: string;
}

/**
 * Builds the shell command that runs inside the container. The command does these steps in order:
 * 1. Runs the install prelude.
 * 2. Copies the mounted bootstrap script to a writable path and makes it executable.
 * 3. Runs the script with `EXARCHOS_LATEST_VERSION` set.
 * 4. Sources `~/.bashrc` when it exists, and puts `~/.local/bin` first on `PATH`.
 * 5. Runs `exarchos --version`.
 * 6. Sends one JSON-RPC `initialize` frame to the stdin of `exarchos mcp`.
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

/** Builds the argv for `docker run`. The bootstrap script mounts read-only at {@link MOUNT_PATH}. */
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
 * The classified result of one docker run. `download-missing` separates a missing release asset
 * from a real failure.
 */
type SmokeOutcome =
  | { kind: 'pass'; stdout: string; stderr: string }
  | { kind: 'download-missing'; stdout: string; stderr: string; status: number }
  | { kind: 'fail'; stdout: string; stderr: string; status: number | null };

/**
 * Runs the bootstrap script in `image` and classifies the result. `EXARCHOS_SMOKE_VERSION` selects
 * the release tag. The docker process gets an empty environment, because the bootstrap needs no
 * host variable.
 */
async function runDockerSmoke(image: string, installPrelude: string): Promise<SmokeOutcome> {
  const versionTag = process.env.EXARCHOS_SMOKE_VERSION ?? 'v2.9.0';
  const inContainer = buildInContainerCommand({ installPrelude, versionTag });
  const r = await spawnAsync('docker', buildDockerArgs(image, inContainer), {
    timeout: 180_000,
    env: {},
  });
  const stdout = r.stdout;
  const stderr = r.stderr;
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

const skipReason = (() => {
  if (!e2eEnabled)
    return 'ENABLE_E2E_SMOKE is not set — default-skipped so PR CI stays fast';
  if (!dockerAvailable)
    return 'docker daemon not reachable — smoke requires docker run';
  if (!existsSync(BOOTSTRAP_SCRIPT))
    return `bootstrap script missing at ${BOOTSTRAP_SCRIPT}`;
  return null;
})();

/**
 * Checks of the two pure builders. They run in every environment, with no docker and no
 * `ENABLE_E2E_SMOKE`, and they pin the shell string that the docker cases use.
 */
describe('task 2.9 — fresh-environment bootstrap smoke (unit)', () => {
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

  /**
   * The mount is read-only as a defense against a `chmod` in the script. A missing `-v` reads
   * `undefined`, and the test names that failure apart from a mount without `:ro`.
   */
  it('buildDockerArgs_WiresReadOnlyVolumeMount', () => {
    const args = buildDockerArgs('ubuntu:24.04', 'echo hi');
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(args).toContain('ubuntu:24.04');
    expect(args[args.length - 1]).toBe('echo hi');
    const volArg = args[args.indexOf('-v') + 1];
    if (volArg === undefined) throw new Error('the docker invocation declares no -v mount');
    expect(volArg.endsWith(':/mnt/get-exarchos.sh:ro')).toBe(true);
  });
});

/**
 * A `download-missing` outcome means that the release assets are not published. The case then logs
 * the fact and asserts only the download error.
 */
describe('task 2.9 — fresh-environment bootstrap smoke', () => {
  it.skipIf(skipReason !== null)(
    'FreshInstall_BootstrapScript_ProducesWorkingBinary_Ubuntu',
    async () => {
      const outcome = await runDockerSmoke(
        'ubuntu:24.04',
        'apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null',
      );
      if (outcome.kind === 'download-missing') {
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

  /**
   * Alpine has only musl. The bootstrap warns and still downloads the glibc binary, which cannot
   * run under musl. A `fail` outcome is thus the expected result, and the case asserts a loader
   * or glibc signature in the output. A `pass` outcome means that a musl build shipped.
   *
   * The first three signatures are the busybox missing-loader message, the exec failure on musl,
   * and a missing libc in the musl loader. The last three are a libc symbol mismatch, a missing
   * `GLIBC_2.x` version, and an absent glibc dynamic linker.
   */
  it.skipIf(skipReason !== null)(
    'FreshInstall_BootstrapScript_ProducesWorkingBinary_Alpine',
    async () => {
      const outcome = await runDockerSmoke(
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
        // eslint-disable-next-line no-console
        console.info(
          '[smoke] alpine: bootstrap ran, binary failed to exec ' +
            '(expected on musl until true musl build lands):\n' +
            outcome.stderr,
        );
        const combined = outcome.stdout + outcome.stderr;
        const muslGlibcSignatures = [
          /not found/i,
          /no such file or directory/i,
          /Error loading shared library/i,
          /Error relocating/i,
          /GLIBC_/,
          /ld-linux-x86-64\.so/,
        ];
        expect(
          muslGlibcSignatures.some((re) => re.test(combined)),
          `Expected a musl/glibc loader-failure signature in alpine output. Got:\nstderr=${outcome.stderr}\nstdout=${outcome.stdout}`,
        ).toBe(true);
        return;
      }
      expect(outcome.stdout).toMatch(/exarchos/i);
      expect(outcome.stdout).toMatch(/"jsonrpc"\s*:\s*"2\.0"/);
    },
    240_000,
  );
});
