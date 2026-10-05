/**
 * Acceptance suite for the installers and the signed release manifest.
 * It runs the real installers, `tools/release/get-exarchos.sh` under bash and
 * `tools/release/get-exarchos.ps1` under pwsh, against a signed fixture release.
 *
 * Only the origin is a stub: a `node:http` server on loopback serves the fixture.
 * The build-identity banner, the Ed25519-signed manifest, the SHA-512 sidecars and the verifier are real.
 * The suite builds the verifier with the `build:release-verifier` script of `package.json`.
 *
 * Each probe seeds one fault and leaves the other checks intact, so a rejection names the check under test.
 * The asset probe corrupts the bytes and regenerates the sidecar, so only the signed manifest can catch it.
 * Each case runs under both shells, because a guard can be alive on one shell and dead on the other.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { spawnAsync } from '../../tools/test-helpers/spawn.js';

import {
  buildReleaseFixture,
  type ReleaseFixture,
  type ReleaseFixtureOptions,
} from '../../tools/audit/test-fixtures/release-fixture.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';
import { makeRepoSandbox, type RepoSandbox } from '../../tools/test-helpers/repo-sandbox.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const SH_INSTALLER = join(REPO_ROOT, 'tools', 'release', 'get-exarchos.sh');
const PS1_INSTALLER = join(REPO_ROOT, 'tools', 'release', 'get-exarchos.ps1');

/** The repo-relative path that package.json builds the verifier to and ships. */
const SHIPPED_VERIFIER_PATH = 'dist/release-verify.js';

/**
 * The package as `npm pack` sees it: `package.json`, the shipped roots of `files[]`, and the built verifier.
 * It is a sandbox copy, so the build and the pack never write to the live checkout.
 */
let packageCopy: RepoSandbox | undefined;
let SHIPPED_VERIFIER = '';

/** Returns the root of the package copy. It throws when the copy is absent, so a pack never runs in the live tree. */
function packageCopyRoot(): string {
  if (packageCopy === undefined) throw new Error('the package copy was not built');
  return packageCopy.root;
}

const LINUX_ASSET = 'exarchos-linux-x64';
const WINDOWS_ASSET = 'exarchos-windows-x64.exe';

/**
 * On Windows, `bun` is a `.cmd` or `.ps1` shim, so a spawn without a shell cannot find it by name.
 * `tests/scripts/build-release-manifest.test.ts` holds the same resolver.
 */
function resolveBunExecutable(): string {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d.length > 0);
  const direct = process.platform === 'win32' ? 'bun.exe' : 'bun';
  for (const dir of dirs) {
    const p = join(dir, direct);
    if (existsSync(p)) return p;
  }
  if (process.platform === 'win32') {
    for (const dir of dirs) {
      const p = join(dir, 'node_modules', 'bun', 'bin', 'bun.exe');
      if (existsSync(p)) return p;
    }
  }
  return 'bun';
}

async function resolveBash(): Promise<string | undefined> {
  const candidates =
    process.platform === 'win32'
      ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe']
      : ['/bin/bash', '/usr/bin/bash'];
  for (const c of candidates) if (existsSync(c)) return c;
  const probe = await spawnAsync('bash', ['-c', 'echo ok'], { timeout: 15_000 });
  return probe.status === 0 ? 'bash' : undefined;
}

async function resolvePwsh(): Promise<string | undefined> {
  for (const exe of ['pwsh', 'powershell']) {
    const probe = await spawnAsync(exe, ['-NoProfile', '-Command', 'exit 0'], {
      timeout: 20_000,
    });
    if (probe.status === 0) return exe;
  }
  return undefined;
}

const BASH = await resolveBash();
const PWSH = await resolvePwsh();

/**
 * The waiver for a skipped installer suite.
 * A bare `skipIf` drops every test of an absent shell, and the run still reports success.
 * Off CI, the skip stays, so a contributor without pwsh can run the rest of the suite.
 * On CI, both shells are required. The waiver names an issue and an expiry date, and a test asserts the expiry.
 *
 * The same date is in `ci.yml` and in `tools/audit/gates/validate-manifest.json`.
 * `tests/scripts/run-validate.test.ts` requires the three dates to agree.
 */
const SHELL_SKIP_WAIVER = Object.freeze({
  issue: '#1789',
  expires: '2026-11-30',
  why: 'pwsh is not installed on every dev host; CI is the enforcing lane.',
});

/** True on GitHub Actions and the usual CI providers (`CI=true`). */
const IS_CI = !['', '0', 'false'].includes((process.env['CI'] ?? '').toLowerCase());

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns a suite title that names the absent shell and the waiver, so the reporter output shows the skip. */
function shellSuite(title: string, resolved: string | undefined, shell: string): string {
  return resolved !== undefined
    ? title
    : `${title} — SKIPPED (${shell} unavailable; tolerated off-CI until ` +
        `${SHELL_SKIP_WAIVER.expires}, ${SHELL_SKIP_WAIVER.issue})`;
}

/** MSYS/Git-Bash resolves drive-letter paths only with forward slashes. */
function toShellPath(p: string): string {
  return p.replace(/\\/g, '/');
}

interface Origin {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * Serves a fixture directory on loopback with the URL shape that the installers build
 * (`<base>/download/<tag>/<file>`). It refuses a path that resolves outside `rootDir`.
 */
async function startOrigin(rootDir: string): Promise<Origin> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const target = resolve(rootDir, `.${decodeURIComponent(url.pathname)}`);
    if (!target.startsWith(resolve(rootDir))) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.statusCode = 200;
    createReadStream(target).pipe(res);
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('origin failed to bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

interface RunResult {
  readonly status: number | null;
  readonly output: string;
}

/**
 * Runs a child process and does not block the event loop of this worker.
 * The loopback origin lives in this process, so a synchronous wait with `spawnSync` deadlocks the download.
 */
function runAsync(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise<RunResult>((done, fail) => {
    const child = spawn(command, [...args], { env, cwd: REPO_ROOT, windowsHide: true });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ status: code, output });
    });
  });
}

interface InstallerRun {
  readonly fixture: ReleaseFixture;
  readonly baseUrl: string;
  readonly installDir: string;
  readonly home: string;
  /** Omit to exercise the installer's own verifier discovery. */
  readonly verifier?: string;
  /** Omit to use the trust root pinned in the installer that runs. */
  readonly trustRootPem?: string | undefined;
  /** Runs this copy of the installer instead of the shipped one. */
  readonly script?: string;
  readonly allowModifiedSource?: boolean;
  /** The tag that the installer requests. The default is the tag of the fixture. */
  readonly requestTag?: string;
  /**
   * Feeds the installer to the shell on stdin, as `curl | bash` and `irm | iex` do.
   * The installer then knows no script directory and PATH holds no verifier bin, so only the built-in verifier is left.
   */
  readonly piped?: boolean;
  /** Replaces PATH for the run. */
  readonly path?: string;
}

/** True when `name` (or its Windows shim) is a file in `dir`. */
function dirHolds(dir: string, name: string): boolean {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.ps1'] : [''];
  return exts.some((ext) => existsSync(join(dir, `${name}${ext}`)));
}

/** The current PATH without the directories that hold `name`. */
function pathWithout(name: string): string {
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0 && !dirHolds(dir, name))
    .join(delimiter);
}

/** The absolute path of an executable on the current PATH, or the bare name. */
function onPath(name: string): string {
  const dir = (process.env['PATH'] ?? '').split(delimiter).find((d) => d.length > 0 && dirHolds(d, name));
  if (dir === undefined) return name;
  const exe = process.platform === 'win32' && existsSync(join(dir, `${name}.exe`)) ? `${name}.exe` : name;
  return join(dir, exe);
}

/** Sets PATH and deletes each copy of the key with a different case, because Windows spells it `Path`. */
function withPath(env: NodeJS.ProcessEnv, value: string): void {
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env['PATH'] = value;
}

/**
 * Drives `get-exarchos.sh`. A bash prelude puts a `uname` shim first on PATH, so the installer detects Linux on each host.
 * On Windows, git-bash reports `MINGW64_NT-…`.
 * The prelude creates the shim directory inside bash, so the path needs no translation to POSIX form.
 */
function runShInstaller(run: InstallerRun): Promise<RunResult> {
  if (BASH === undefined) throw new Error('bash unavailable');
  const preludeDir = mkdtempSync(join(tmpdir(), 'exa-sh-'));
  const prelude = join(preludeDir, 'drive.sh');
  writeFileSync(
    prelude,
    [
      'set -u',
      'FAKEBIN="$(mktemp -d)"',
      "cat > \"$FAKEBIN/uname\" <<'EOF'",
      '#!/usr/bin/env bash',
      'case "$1" in',
      '  -s) echo Linux ;;',
      '  -m) echo x86_64 ;;',
      '  *)  echo Linux ;;',
      'esac',
      'EOF',
      'chmod +x "$FAKEBIN/uname"',
      'export PATH="$FAKEBIN:$PATH"',
      run.piped === true ? 'cat "$EXARCHOS_SCRIPT" | bash -s -- "$@"' : 'exec bash "$EXARCHOS_SCRIPT" "$@"',
      '',
    ].join('\n'),
    { encoding: 'utf8' },
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EXARCHOS_SCRIPT: toShellPath(run.script ?? SH_INSTALLER),
    EXARCHOS_RELEASE_BASE_URL: run.baseUrl,
    EXARCHOS_LATEST_VERSION: run.requestTag ?? run.fixture.tag,
    EXARCHOS_INSTALL_DIR: toShellPath(run.installDir),
    HOME: toShellPath(run.home),
  };
  delete env['EXARCHOS_RELEASE_VERIFIER'];
  delete env['EXARCHOS_TRUST_ROOT_PEM_FILE'];
  if (run.verifier !== undefined) env['EXARCHOS_RELEASE_VERIFIER'] = toShellPath(run.verifier);
  if (run.trustRootPem !== undefined)
    env['EXARCHOS_TRUST_ROOT_PEM_FILE'] = toShellPath(run.trustRootPem);
  if (run.piped === true) withPath(env, run.path ?? pathWithout('exarchos-release-verify'));
  else if (run.path !== undefined) withPath(env, run.path);

  const args = [toShellPath(prelude)];
  if (run.allowModifiedSource === true) args.push('--allow-modified-source');

  return runAsync(BASH, args, env).finally(() => {
    rmrf(preludeDir);
  });
}

/** Drives `get-exarchos.ps1` with the same fixture release. */
function runPs1Installer(run: InstallerRun): Promise<RunResult> {
  if (PWSH === undefined) throw new Error('pwsh unavailable');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EXARCHOS_RELEASE_BASE_URL: run.baseUrl,
    EXARCHOS_LATEST_VERSION: run.requestTag ?? run.fixture.tag,
    EXARCHOS_INSTALL_DIR: run.installDir,
    PROCESSOR_ARCHITECTURE: 'AMD64',
  };
  delete env['EXARCHOS_RELEASE_VERIFIER'];
  delete env['EXARCHOS_TRUST_ROOT_PEM_FILE'];
  if (run.verifier !== undefined) env['EXARCHOS_RELEASE_VERIFIER'] = run.verifier;
  if (run.trustRootPem !== undefined) env['EXARCHOS_TRUST_ROOT_PEM_FILE'] = run.trustRootPem;

  if (run.piped === true) {
    const pwsh = onPath(PWSH);
    env['EXARCHOS_SCRIPT'] = run.script ?? PS1_INSTALLER;
    withPath(env, run.path ?? pathWithout('exarchos-release-verify'));
    return runAsync(
      pwsh,
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Content -Raw -LiteralPath $env:EXARCHOS_SCRIPT | Invoke-Expression'],
      env,
    );
  }

  const args = ['-NoProfile', '-NonInteractive', '-File', run.script ?? PS1_INSTALLER];
  if (run.allowModifiedSource === true) args.push('-AllowModifiedSource');

  return runAsync(PWSH, args, env);
}

/** Returns the built-in verifier text that an installer carries between two marker lines. */
function builtInVerifierOf(path: string, open: string, close: string): string {
  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf(open);
  const end = lines.indexOf(close, start + 1);
  if (start < 0 || end < 0) throw new Error(`${path} carries no built-in verifier between '${open}' and '${close}'`);
  return lines.slice(start + 1, end).join('\n');
}

/** Exit code and verdict tag of one verifier run. */
async function verdictOf(
  verifier: string,
  args: readonly string[],
): Promise<{ status: number | null; verdict: string }> {
  const run = await spawnAsync(process.execPath, [verifier, ...args], { timeout: 60_000 });
  const text = `${run.stdout}${run.stderr}`;
  const tag = /release REJECTED \[([a-z-]+)\]/.exec(text)?.[1];
  const verdict = tag ?? (text.includes('release verified') ? 'verified' : text.includes('usage error') ? 'usage' : text);
  return { status: run.status, verdict };
}

let scratch: string;
let origins: Origin[] = [];

interface Scenario {
  readonly fixture: ReleaseFixture;
  readonly origin: Origin;
}

async function scenario(
  name: string,
  options: Omit<ReleaseFixtureOptions, 'outDir' | 'assets'> &
    Partial<Pick<ReleaseFixtureOptions, 'assets'>>,
): Promise<Scenario> {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const fixture = buildReleaseFixture({
    ...options,
    outDir: dir,
    assets: options.assets ?? [LINUX_ASSET, WINDOWS_ASSET],
  });
  const origin = await startOrigin(dir);
  origins.push(origin);
  return { fixture, origin };
}

function freshTarget(name: string): { installDir: string; home: string } {
  const installDir = join(scratch, 'targets', name, 'bin');
  const home = join(scratch, 'targets', name, 'home');
  mkdirSync(installDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { installDir, home };
}

const UNPINNED_SENTINEL = '__EXARCHOS_PUBLISHER_TRUST_ROOT_PEM_UNPINNED__';

/** A copy of an installer whose trust-root assignment holds the unpinned sentinel again. */
function unpinnedCopyOf(installer: string, name: string): string {
  const assignment = installer.endsWith('.ps1')
    ? { pattern: /^\$script:PinnedTrustRootPem = '[^']*'$/gm, value: `$script:PinnedTrustRootPem = '${UNPINNED_SENTINEL}'` }
    : { pattern: /^PINNED_TRUST_ROOT_PEM="[^"]*"$/gm, value: `PINNED_TRUST_ROOT_PEM="${UNPINNED_SENTINEL}"` };
  const text = readFileSync(installer, 'utf8');
  expect(text.match(assignment.pattern), `${installer} must hold exactly one trust-root assignment`).toHaveLength(1);
  const dir = join(scratch, 'unpinned', name);
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, basename(installer));
  writeFileSync(copy, text.replace(assignment.pattern, () => assignment.value), 'utf8');
  return copy;
}

function installedNames(installDir: string): string[] {
  return ['exarchos', 'exarchos.exe'].filter((n) => existsSync(join(installDir, n)));
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'exarchos-installer-dr20-'));

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    files?: string[];
  };
  const script = pkg.scripts['build:release-verifier'];
  if (script === undefined) throw new Error('package.json lost the build:release-verifier script');
  const argv = (script.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''));
  expect(argv[0]).toBe('bun');
  const outfileFlag = argv.indexOf('--outfile');
  expect(argv[outfileFlag + 1], 'build:release-verifier must write the shipped verifier path').toBe(
    SHIPPED_VERIFIER_PATH,
  );

  const shippedRoots = (pkg.files ?? []).filter((entry) => !entry.startsWith('dist/') && existsSync(join(REPO_ROOT, entry)));
  packageCopy = await makeRepoSandbox({ prefix: 'installer-verify-package', copy: ['package.json', ...shippedRoots] });
  SHIPPED_VERIFIER = packageCopy.path(SHIPPED_VERIFIER_PATH);
  const buildArgs = argv.slice(1).map((arg, index) => (index === outfileFlag ? SHIPPED_VERIFIER : arg));
  const build = await spawnAsync(resolveBunExecutable(), buildArgs, {
    cwd: REPO_ROOT,
    timeout: 180_000,
  });
  if (build.status !== 0) {
    throw new Error(
      `build:release-verifier failed (${String(build.status)}):\n${build.stdout}\n${build.stderr}`,
    );
  }
  if (!existsSync(SHIPPED_VERIFIER)) {
    throw new Error(
      `build:release-verifier ran but did not produce ${SHIPPED_VERIFIER} — the shipped verifier path is not what package.json builds`,
    );
  }
}, 300_000);

afterAll(async () => {
  for (const origin of origins) await origin.close();
  origins = [];
  if (scratch !== undefined) rmrf(scratch);
  packageCopy?.remove();
});

describe('DR-20 — the installers consume the signed release manifest', () => {
  /**
   * This test is the reason that the two `skipIf` suites can exist, and it always runs.
   * On CI, an absent shell fails it, so neither suite can report success without a run.
   * Off CI, it tolerates an absent shell until the waiver expires, and it prints a warning.
   * A host with both shells uses no waiver, so the expiry check does not apply there.
   * The `expires` date is the last tolerated day.
   */
  it('InstallerVerify_ShellAbsent_FailsClosedRatherThanSkipping', () => {
    const missing = [
      ...(BASH === undefined ? ['bash'] : []),
      ...(PWSH === undefined ? ['pwsh (or powershell)'] : []),
    ];

    if (IS_CI) {
      expect(
        missing,
        `DR-20 acceptance requires BOTH installer shells on CI, but ${missing.join(' and ')} ` +
          `${missing.length === 1 ? 'is' : 'are'} unavailable. ${missing.length} of the two ` +
          `installer suites would be SKIPPED in full and the run would still ` +
          `report success. Install the missing shell on this lane; do not widen the waiver.`,
      ).toEqual([]);
      return;
    }

    if (missing.length > 0) {
      expect(
        SHELL_SKIP_WAIVER.expires >= todayUtc(),
        `The off-CI installer-shell skip waiver (${SHELL_SKIP_WAIVER.issue}) expired on ` +
          `${SHELL_SKIP_WAIVER.expires} and ${missing.join(' and ')} ` +
          `${missing.length === 1 ? 'is' : 'are'} still missing. Either install both shells ` +
          `locally, or re-justify and re-date the waiver — a tolerated skip with no live ` +
          `expiry is a permanent one.`,
      ).toBe(true);
    }

    if (missing.length > 0) {
      console.warn(
        `[installer-verify] SKIPPING ${missing.join(' and ')} installer suite(s) — ` +
          `tolerated off CI until ${SHELL_SKIP_WAIVER.expires} (${SHELL_SKIP_WAIVER.issue}). ` +
          `${SHELL_SKIP_WAIVER.why}`,
      );
    }
  });

  /**
   * The `build` script must include the verifier build.
   * The built verifier is a real CLI: with no arguments, it exits 3 (usage error).
   */
  it('the verifier is shipped: package.json exposes it as a bin and includes it in files[]', async () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
      files?: string[];
      scripts: Record<string, string>;
    };
    expect(pkg.bin?.['exarchos-release-verify']).toBe('dist/release-verify.js');
    expect(pkg.files).toContain('dist/release-verify.js');
    expect(pkg.scripts['build']).toContain('build:release-verifier');
    expect(existsSync(SHIPPED_VERIFIER)).toBe(true);

    const probe = await spawnAsync(process.execPath, [SHIPPED_VERIFIER], {
      timeout: 60_000,
    });
    expect(probe.status).toBe(3);
    expect(`${probe.stdout}${probe.stderr}`).toContain('--manifest is required');
  }, 120_000);

  /**
   * `files[]` holds no negation for fixtures or tests, so this check of the tarball is the only defense.
   * A shipped root that carries test-only paths fails here by name.
   * The floor on the file count stops a vacuous pass on an empty or unparsed pack.
   * On Windows, the spawn uses a shell, because Node refuses to spawn a `.cmd` shim without one (CVE-2024-27980).
   */
  it('npm pack ships dist/release-verify.js and not the test fixtures', async () => {
    const isWin = process.platform === 'win32';
    const packed = await spawnAsync(
      isWin ? 'npm.cmd' : 'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: packageCopyRoot(), timeout: 300_000, shell: isWin },
    );
    expect(packed.status, `${String(packed.error)}\n${packed.stderr}`).toBe(0);
    const files = (
      JSON.parse(packed.stdout) as ReadonlyArray<{ files: ReadonlyArray<{ path: string }> }>
    )[0]?.files.map((f) => f.path.replace(/\\/g, '/'));
    expect(files).toBeDefined();
    expect(files).toContain('dist/release-verify.js');

    expect(files!.length).toBeGreaterThan(50);
    const leaked = files!.filter(
      (f) => /(^|\/)(test-fixtures|trigger-tests)\//.test(f) || /\.test\.(ts|sh|ps1)$/.test(f),
    );
    expect(leaked, `test-only paths in the tarball: ${leaked.join(', ')}`).toEqual([]);
  }, 360_000);

  describe('the built-in verifier both installers carry', () => {
    const shCopy = (): string =>
      builtInVerifierOf(SH_INSTALLER, `    cat > "$1" <<'EXARCHOS_EMBEDDED_VERIFIER'`, 'EXARCHOS_EMBEDDED_VERIFIER');
    const ps1Copy = (): string =>
      builtInVerifierOf(PS1_INSTALLER, "$script:EmbeddedReleaseVerifier = @'", "'@");

    it('BuiltInVerifier_BothInstallers_CarryTheSameAsciiCopy', () => {
      const sh = shCopy();
      expect(sh.split('\n').length).toBeGreaterThan(50);
      expect(sh).toContain('crypto.verify(null');
      expect(/^[\x09\x0a\x20-\x7e]*$/.test(sh), 'the built-in verifier must be ASCII').toBe(true);
      expect(ps1Copy()).toBe(sh);
    });

    it('BuiltInVerifier_EverySeededFault_ReturnsTheShippedVerifierVerdict', async () => {
      const builtIn = join(scratch, 'built-in-verifier.cjs');
      writeFileSync(builtIn, `${shCopy()}\n`, 'utf8');
      const faults: ReadonlyArray<readonly [string, Omit<ReleaseFixtureOptions, 'outDir' | 'assets'>, string]> = [
        ['clean', {}, 'verified'],
        ['signature', { corruptSignature: true }, 'manifest-signature'],
        ['wrong-key', { signWithWrongKey: true }, 'manifest-signature'],
        ['source', { manifestCommit: 'a'.repeat(40) }, 'source-mismatch'],
        ['contract', { manifestContractDigest: `sha256:${'c'.repeat(64)}` }, 'contract-mismatch'],
        ['asset', { corruptAssetAfterSigning: LINUX_ASSET }, 'asset-digest'],
      ];
      for (const [name, options, expected] of faults) {
        const fixture = buildReleaseFixture({
          ...options,
          outDir: join(scratch, 'parity', name),
          assets: [LINUX_ASSET],
        });
        const args = [
          '--manifest', fixture.manifestPath,
          '--trust-root', `${fixture.keyId}=${fixture.trustRootPem}`,
          '--expect-source', `${fixture.commit}#${fixture.treeDigest}`,
          '--expect-contract', fixture.contractDigest,
          '--asset', `${LINUX_ASSET}=${join(fixture.releaseDir, LINUX_ASSET)}`,
        ];
        const shipped = await verdictOf(SHIPPED_VERIFIER, args);
        const carried = await verdictOf(builtIn, args);
        expect(shipped.verdict, `shipped verifier on '${name}'`).toBe(expected);
        expect(carried, `built-in verifier on '${name}'`).toEqual(shipped);
      }
      expect(await verdictOf(builtIn, [])).toEqual(await verdictOf(SHIPPED_VERIFIER, []));
    }, 180_000);
  });

  describe.skipIf(BASH === undefined)(shellSuite('tools/release/get-exarchos.sh', BASH, 'bash'), () => {
    /** The verified path must still write the PATH block to `.bashrc`. */
    it('installs a release whose signed manifest verifies on all four dimensions', async () => {
      const { fixture, origin } = await scenario('sh-happy', {});
      const target = freshTarget('sh-happy');
      const result = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('release manifest verified');
      expect(installedNames(target.installDir)).toContain('exarchos');
      expect(readFileSync(join(target.home, '.bashrc'), 'utf8')).toContain('>>> exarchos >>>');
    }, 180_000);

    it('Installer_ManifestMismatch_RejectsInstall — a tampered signature aborts', async () => {
      const { fixture, origin } = await scenario('sh-sig', { corruptSignature: true });
      const target = freshTarget('sh-sig');
      const result = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('manifest-signature');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    /**
     * The second run pins the key that signed the fixture, and the install succeeds.
     * Thus the first rejection came from the pin, not from an unconditional refusal.
     */
    it('Installer_ManifestMismatch_RejectsInstall — a manifest signed by an unpinned key aborts', async () => {
      const { fixture, origin } = await scenario('sh-wrongkey', { signWithWrongKey: true });
      const target = freshTarget('sh-wrongkey');
      const result = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('manifest-signature');
      expect(installedNames(target.installDir)).toEqual([]);

      const target2 = freshTarget('sh-wrongkey-pinned');
      const pinned = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target2,
        trustRootPem: fixture.wrongTrustRootPem,
      });
      expect(pinned.status, pinned.output).toBe(0);
    }, 240_000);

    it('with NO trust root pinned or supplied, the install fails closed (never skips)', async () => {
      const { fixture, origin } = await scenario('sh-nokey', {});
      const target = freshTarget('sh-nokey');
      const result = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: undefined,
        script: unpinnedCopyOf(SH_INSTALLER, 'sh-nokey'),
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('trust-root');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('Installer_ContractDigestMismatch_RejectsInstall — a validly-signed wrong contract aborts', async () => {
      const { fixture, origin } = await scenario('sh-contract', {
        manifestContractDigest: `sha256:${'c'.repeat(64)}`,
      });
      const target = freshTarget('sh-contract');
      const result = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('contract-mismatch');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('a validly-signed manifest describing a different SOURCE aborts', async () => {
      const { fixture, origin } = await scenario('sh-source', {
        manifestCommit: 'a'.repeat(40),
      });
      const target = freshTarget('sh-source');
      const result = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('source-mismatch');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    /** The sidecar check passes first, so only the signed manifest can catch this fault. */
    it('ASSET mismatch aborts even though the SHA-512 sidecar matches', async () => {
      const { fixture, origin } = await scenario('sh-asset', {
        corruptAssetAfterSigning: LINUX_ASSET,
      });
      const target = freshTarget('sh-asset');
      const result = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.output).toContain('sha512 checksum verified');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('asset-digest');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    /**
     * The origin publishes the current release under the tag `v9.9.9`.
     * Signature, source, contract and asset digest all verify, so only the release binding can reject it.
     */
    it('a validly-signed manifest for a DIFFERENT release aborts (rollback)', async () => {
      const { fixture, origin } = await scenario('sh-binding', { tag: 'v9.9.9' });
      const target = freshTarget('sh-binding');
      const result = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.output).toContain('release verified');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('release-binding');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('an artifact built from a MODIFIED source tree is refused by default and accepted only with --allow-modified-source', async () => {
      const { fixture, origin } = await scenario('sh-modified', { sourceState: 'modified' });

      const refused = freshTarget('sh-modified-refused');
      const blocked = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...refused,
        trustRootPem: fixture.trustRootPem,
      });
      expect(blocked.status, blocked.output).not.toBe(0);
      expect(blocked.output).toContain('source-state');
      expect(installedNames(refused.installDir)).toEqual([]);

      const allowed = freshTarget('sh-modified-allowed');
      const escaped = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...allowed,
        trustRootPem: fixture.trustRootPem,
        allowModifiedSource: true,
      });
      expect(escaped.status, escaped.output).toBe(0);
      expect(installedNames(allowed.installDir)).toContain('exarchos');
    }, 240_000);

    it('a v1 build-identity banner is treated as untrustworthy, not as clean', async () => {
      const { fixture, origin } = await scenario('sh-v1', {
        marker: 'exarchos-build-identity/v1',
      });
      const target = freshTarget('sh-v1');
      const result = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('build-identity');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('a release with no published manifest is refused', async () => {
      const { fixture, origin } = await scenario('sh-nomanifest', {});
      rmSync(fixture.manifestPath);
      const target = freshTarget('sh-nomanifest');
      const result = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/manifest/i);
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('curl | bash with no verifier installed verifies with the built-in verifier and installs', async () => {
      const { fixture, origin } = await scenario('sh-piped', {});
      const target = freshTarget('sh-piped');
      const result = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
        piped: true,
      });
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('exarchos-release-verify.cjs');
      expect(result.output).toContain('(built-in verifier)');
      expect(result.output).toContain('release manifest verified');
      expect(installedNames(target.installDir)).toContain('exarchos');
    }, 180_000);

    it('curl | bash: the built-in verifier rejects a tampered signature', async () => {
      const { fixture, origin } = await scenario('sh-piped-sig', { corruptSignature: true });
      const target = freshTarget('sh-piped-sig');
      const result = await runShInstaller({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
        piped: true,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('exarchos-release-verify.cjs');
      expect(result.output).toContain('manifest-signature');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);
  });

  describe.skipIf(PWSH === undefined)(shellSuite('tools/release/get-exarchos.ps1', PWSH, 'pwsh'), () => {
    it('installs a release whose signed manifest verifies on all four dimensions', async () => {
      const { fixture, origin } = await scenario('ps-happy', {});
      const target = freshTarget('ps-happy');
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('Release manifest verified');
      expect(installedNames(target.installDir)).toContain('exarchos.exe');
    }, 180_000);

    it('Installer_ManifestMismatch_RejectsInstall — a tampered signature aborts', async () => {
      const { fixture, origin } = await scenario('ps-sig', { corruptSignature: true });
      const target = freshTarget('ps-sig');
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('manifest-signature');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('Installer_ManifestMismatch_RejectsInstall — a manifest signed by an unpinned key aborts', async () => {
      const { fixture, origin } = await scenario('ps-wrongkey', { signWithWrongKey: true });
      const target = freshTarget('ps-wrongkey');
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('manifest-signature');
      expect(installedNames(target.installDir)).toEqual([]);

      const target2 = freshTarget('ps-wrongkey-pinned');
      const pinned = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target2,
        trustRootPem: fixture.wrongTrustRootPem,
      });
      expect(pinned.status, pinned.output).toBe(0);
    }, 240_000);

    it('with NO trust root pinned or supplied, the install fails closed (never skips)', async () => {
      const { fixture, origin } = await scenario('ps-nokey', {});
      const target = freshTarget('ps-nokey');
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: undefined,
        script: unpinnedCopyOf(PS1_INSTALLER, 'ps-nokey'),
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('trust-root');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('Installer_ContractDigestMismatch_RejectsInstall — a validly-signed wrong contract aborts', async () => {
      const { fixture, origin } = await scenario('ps-contract', {
        manifestContractDigest: `sha256:${'c'.repeat(64)}`,
      });
      const target = freshTarget('ps-contract');
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('contract-mismatch');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('a validly-signed manifest describing a different SOURCE aborts', async () => {
      const { fixture, origin } = await scenario('ps-source', { manifestCommit: 'a'.repeat(40) });
      const target = freshTarget('ps-source');
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('source-mismatch');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('ASSET mismatch aborts even though the SHA-512 sidecar matches', async () => {
      const { fixture, origin } = await scenario('ps-asset', {
        corruptAssetAfterSigning: WINDOWS_ASSET,
      });
      const target = freshTarget('ps-asset');
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.output).toContain('Verifying SHA-512 checksum');
      expect(result.output).not.toContain('Checksum mismatch');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('asset-digest');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('a validly-signed manifest for a DIFFERENT release aborts (rollback)', async () => {
      const { fixture, origin } = await scenario('ps-binding', { tag: 'v9.9.9' });
      const target = freshTarget('ps-binding');
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.output).toContain('release verified');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('release-binding');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('an artifact built from a MODIFIED source tree is refused by default and accepted only with -AllowModifiedSource', async () => {
      const { fixture, origin } = await scenario('ps-modified', { sourceState: 'modified' });

      const refused = freshTarget('ps-modified-refused');
      const blocked = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...refused,
        trustRootPem: fixture.trustRootPem,
      });
      expect(blocked.status, blocked.output).not.toBe(0);
      expect(blocked.output).toContain('source-state');
      expect(installedNames(refused.installDir)).toEqual([]);

      const allowed = freshTarget('ps-modified-allowed');
      const escaped = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...allowed,
        trustRootPem: fixture.trustRootPem,
        allowModifiedSource: true,
      });
      expect(escaped.status, escaped.output).toBe(0);
      expect(installedNames(allowed.installDir)).toContain('exarchos.exe');
    }, 240_000);

    it('a v1 build-identity banner is treated as untrustworthy, not as clean', async () => {
      const { fixture, origin } = await scenario('ps-v1', { marker: 'exarchos-build-identity/v1' });
      const target = freshTarget('ps-v1');
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('build-identity');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('a release with no published manifest is refused', async () => {
      const { fixture, origin } = await scenario('ps-nomanifest', {});
      rmSync(fixture.manifestPath);
      const target = freshTarget('ps-nomanifest');
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/manifest/i);
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('irm | iex with no verifier installed verifies with the built-in verifier and installs', async () => {
      const { fixture, origin } = await scenario('ps-piped', {});
      const target = freshTarget('ps-piped');
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
        piped: true,
      });
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('exarchos-release-verify.cjs');
      expect(result.output).toContain('(built-in verifier)');
      expect(result.output).toContain('Release manifest verified');
      expect(installedNames(target.installDir)).toContain('exarchos.exe');
    }, 180_000);

    it('irm | iex: the built-in verifier rejects a tampered signature', async () => {
      const { fixture, origin } = await scenario('ps-piped-sig', { corruptSignature: true });
      const target = freshTarget('ps-piped-sig');
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
        piped: true,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('exarchos-release-verify.cjs');
      expect(result.output).toContain('manifest-signature');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('irm | iex with no Node.js on PATH refuses and names what to install', async () => {
      const { fixture, origin } = await scenario('ps-piped-nonode', {});
      const target = freshTarget('ps-piped-nonode');
      const emptyPath = join(scratch, 'targets', 'ps-piped-nonode', 'empty-path');
      mkdirSync(emptyPath, { recursive: true });
      const result = await runPs1Installer({
        fixture,
        baseUrl: origin.baseUrl,
        ...target,
        trustRootPem: fixture.trustRootPem,
        piped: true,
        path: emptyPath,
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('verifier-unavailable');
      expect(result.output).toContain('Node.js');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);
  });
});
