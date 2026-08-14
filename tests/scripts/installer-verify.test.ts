// ─── DR-20 acceptance: the installers consume the signed release manifest ────
//
// T-28. This suite drives the REAL bootstrap installers — `tools/release/get-exarchos.sh`
// under bash and `tools/release/get-exarchos.ps1` under pwsh — end to end against a
// REAL, Ed25519-signed, source-linked fixture release served over loopback HTTP.
//
// What is and is not faked:
//   - FAKED: the origin. A `node:http` server stands in for GitHub Releases so
//     the suite is hermetic. The installers use their real `curl` /
//     `Invoke-WebRequest` code paths against it.
//   - NOT FAKED: everything else. Real artifact bytes carrying a real
//     `bun build --banner` build-identity stamp, a real signed manifest built
//     by `tools/release/build-release-manifest.ts`'s producer primitives, real
//     SHA-512 sidecars, and the REAL SHIPPED VERIFIER — `dist/release-verify.js`,
//     produced here by executing package.json's own `build:release-verifier`
//     script, so the packaging change is exercised rather than assumed.
//
// The verification bar is "rejects source, contract, manifest and asset
// mismatch — not merely a corrupted download". Each dimension therefore gets a
// DISCRIMINATING probe: exactly one dimension is faulted, the other three (and
// the SHA-512 sidecar) are left intact and passing, so a rejection can only be
// attributed to the check under test. The asset probe in particular corrupts
// the bytes AND regenerates the sidecar, so the legacy checksum gate passes and
// only the signed manifest can catch it.
//
// Both installers are driven for every case. A guard that is alive on one shell
// and dead on the other is exactly the platform-dependent vacuity that has bitten
// this workstream before.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  buildReleaseFixture,
  type ReleaseFixture,
  type ReleaseFixtureOptions,
} from '../../tools/audit/test-fixtures/release-fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const SH_INSTALLER = join(REPO_ROOT, 'tools', 'release', 'get-exarchos.sh');
const PS1_INSTALLER = join(REPO_ROOT, 'tools', 'release', 'get-exarchos.ps1');
const SHIPPED_VERIFIER = join(REPO_ROOT, 'dist', 'release-verify.js');

const LINUX_ASSET = 'exarchos-linux-x64';
const WINDOWS_ASSET = 'exarchos-windows-x64.exe';

// ─── Toolchain discovery ─────────────────────────────────────────────────────

/**
 * On Windows `bun` is a `.cmd`/`.ps1` shim, not a PATH `.exe`, so `spawnSync`
 * cannot find it by name. Mirrors `scripts/build-release-manifest.test.ts`.
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

function resolveBash(): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe']
      : ['/bin/bash', '/usr/bin/bash'];
  for (const c of candidates) if (existsSync(c)) return c;
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf-8', timeout: 15_000 });
  return probe.status === 0 ? 'bash' : undefined;
}

function resolvePwsh(): string | undefined {
  for (const exe of ['pwsh', 'powershell']) {
    const probe = spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], {
      encoding: 'utf-8',
      timeout: 20_000,
    });
    if (probe.status === 0) return exe;
  }
  return undefined;
}

const BASH = resolveBash();
const PWSH = resolvePwsh();

/** MSYS/Git-Bash resolves drive-letter paths only with forward slashes. */
function toShellPath(p: string): string {
  return p.replace(/\\/g, '/');
}

// ─── Loopback "GitHub Releases" ──────────────────────────────────────────────

interface Origin {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * Serve a fixture directory over loopback at the same URL shape the installers
 * build (`<base>/download/<tag>/<file>`). Only the ORIGIN is stubbed: the
 * installers run their real download + verification code over real bytes.
 */
async function startOrigin(rootDir: string): Promise<Origin> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Contain the served path inside rootDir — a fixture must not be able to
    // make the suite read outside its own directory.
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

// ─── Installer drivers ───────────────────────────────────────────────────────

interface RunResult {
  readonly status: number | null;
  readonly output: string;
}

/**
 * Run a child process WITHOUT blocking this worker's event loop. `spawnSync`
 * cannot be used here: the loopback origin the installer downloads from lives
 * in this same process, so a synchronous wait would deadlock the download.
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
  /** Omit to exercise the (unpinned) trust root fail-closed path. */
  readonly trustRootPem?: string | undefined;
  readonly allowModifiedSource?: boolean;
  /** Tag the installer is asked for; defaults to the fixture's own tag. */
  readonly requestTag?: string;
}

/**
 * Drive `get-exarchos.sh`. A bash prelude installs a `uname` shim so the POSIX
 * installer's Linux platform detection runs unchanged even when the harness
 * host is Windows (git-bash reports `MINGW64_NT-…`). The prelude lives inside
 * the MSYS filesystem, so no Windows→POSIX path translation is involved.
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
      'exec bash "$EXARCHOS_SCRIPT" "$@"',
      '',
    ].join('\n'),
    { encoding: 'utf8' },
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EXARCHOS_SCRIPT: toShellPath(SH_INSTALLER),
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

  const args = [toShellPath(prelude)];
  if (run.allowModifiedSource === true) args.push('--allow-modified-source');

  return runAsync(BASH, args, env).finally(() => {
    rmSync(preludeDir, { recursive: true, force: true });
  });
}

/** Drive `get-exarchos.ps1` with the same fixture release. */
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

  const args = ['-NoProfile', '-NonInteractive', '-File', PS1_INSTALLER];
  if (run.allowModifiedSource === true) args.push('-AllowModifiedSource');

  return runAsync(PWSH, args, env);
}

// ─── Fixture / scratch management ────────────────────────────────────────────

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

function installedNames(installDir: string): string[] {
  return ['exarchos', 'exarchos.exe'].filter((n) => existsSync(join(installDir, n)));
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'exarchos-installer-dr20-'));

  // Build the SHIPPED verifier by running package.json's own script, so the
  // packaging change (`build:release-verifier` + files[] + bin) is executed
  // here rather than merely asserted.
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts['build:release-verifier'];
  if (script === undefined) throw new Error('package.json lost the build:release-verifier script');
  const argv = (script.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''));
  expect(argv[0]).toBe('bun');
  // Remove any artifact from a previous run: otherwise a `build:release-verifier`
  // that no longer emits the shipped path would still leave every installer test
  // green against a stale file.
  rmSync(SHIPPED_VERIFIER, { force: true });
  const build = spawnSync(resolveBunExecutable(), argv.slice(1), {
    encoding: 'utf-8',
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
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('DR-20 — the installers consume the signed release manifest', () => {
  it('the verifier is shipped: package.json exposes it as a bin and includes it in files[]', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
      files?: string[];
      scripts: Record<string, string>;
    };
    expect(pkg.bin?.['exarchos-release-verify']).toBe('dist/release-verify.js');
    expect(pkg.files).toContain('dist/release-verify.js');
    // …and the release build actually produces it.
    expect(pkg.scripts['build']).toContain('build:release-verifier');
    expect(existsSync(SHIPPED_VERIFIER)).toBe(true);

    // It is a real, runnable CLI (usage error == exit 3, per the CLI contract).
    const probe = spawnSync(process.execPath, [SHIPPED_VERIFIER], {
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(probe.status).toBe(3);
    expect(`${probe.stdout}${probe.stderr}`).toContain('--manifest is required');
  }, 120_000);

  it('npm pack ships dist/release-verify.js and not the test fixtures', () => {
    // Node >=20 refuses to spawn a `.cmd` shim without a shell (CVE-2024-27980).
    const isWin = process.platform === 'win32';
    const packed = spawnSync(
      isWin ? 'npm.cmd' : 'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { encoding: 'utf-8', cwd: REPO_ROOT, timeout: 300_000, shell: isWin },
    );
    expect(packed.status, `${String(packed.error)}\n${packed.stderr}`).toBe(0);
    const files = (
      JSON.parse(packed.stdout) as ReadonlyArray<{ files: ReadonlyArray<{ path: string }> }>
    )[0]?.files.map((f) => f.path.replace(/\\/g, '/'));
    expect(files).toBeDefined();
    expect(files).toContain('dist/release-verify.js');

    // This is the whole defence now. `files[]` used to carry
    // `!**/test-fixtures` and `!**/*.test.{sh,ts}`, retired once `scripts/`
    // stopped being published left them excluding nothing. Asserting against
    // the tarball beats asserting against the config: add a shipped root that
    // carries fixtures or tests and this names them, where a negation would
    // have quietly swallowed them. Anchored on a real denominator so an empty
    // or unparsed pack cannot pass by vacuity.
    expect(files!.length).toBeGreaterThan(50);
    const leaked = files!.filter(
      (f) => /(^|\/)(test-fixtures|trigger-tests)\//.test(f) || /\.test\.(ts|sh|ps1)$/.test(f),
    );
    expect(leaked, `test-only paths in the tarball: ${leaked.join(', ')}`).toEqual([]);
  }, 360_000);

  describe.skipIf(BASH === undefined)('tools/release/get-exarchos.sh', () => {
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
      // Post-install PATH wiring still happens on the verified path.
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

      // Same fixture, but the installer pins the impostor's key: it verifies.
      // This is what proves the rejection above was the PINNING, not an
      // unconditional refusal.
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
      // The legacy sidecar gate PASSED — this is not "merely a corrupted
      // download"; only the signed manifest can catch it.
      expect(result.output).toContain('sha512 checksum verified');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('asset-digest');
      expect(installedNames(target.installDir)).toEqual([]);
    }, 180_000);

    it('a validly-signed manifest for a DIFFERENT release aborts (rollback)', async () => {
      // Published under tag `v9.9.9`, but the artifact (and its manifest) are
      // the current release. Every other dimension verifies — signature,
      // source, contract and asset digest all match — so ONLY the release
      // binding can reject this, which is exactly what a rollback looks like.
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
  });

  describe.skipIf(PWSH === undefined)('tools/release/get-exarchos.ps1', () => {
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
  });
});
