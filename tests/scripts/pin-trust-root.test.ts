// Tests for tools/release/pin-trust-root.mjs and the release gate that runs it.
//
// Each tool case uses temporary copies of the two installers that hold the
// sentinel. As a result, the cases pass before and after the real key is pinned.
// The cases generate their keys at runtime and write no key to the repository.
// The gate cases read the workflows. The gate must run before every job that
// publishes. Only release.yml runs the gate, so pull-request CI passes while
// the key is unpinned.

import { describe, it, expect, afterEach } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import yaml from 'js-yaml';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

import { spawnAsync } from '../../tools/test-helpers/spawn.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = join(REPO_ROOT, 'tools', 'release', 'pin-trust-root.mjs');
const SH_INSTALLER = join(REPO_ROOT, 'tools', 'release', 'get-exarchos.sh');
const PS1_INSTALLER = join(REPO_ROOT, 'tools', 'release', 'get-exarchos.ps1');
const WORKFLOWS = join(REPO_ROOT, '.github', 'workflows');
const SENTINEL = '__EXARCHOS_PUBLISHER_TRUST_ROOT_PEM_UNPINNED__';
const IS_CI = !['', '0', 'false'].includes((process.env['CI'] ?? '').toLowerCase());

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmrf(dir);
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pin-trust-root-'));
  scratchDirs.push(dir);
  return dir;
}

/** Copies of both installers whose trust-root assignment holds the sentinel. */
function seededCopies(dir: string): { sh: string; ps1: string } {
  const sh = join(dir, 'get-exarchos.sh');
  const ps1 = join(dir, 'get-exarchos.ps1');
  writeFileSync(
    sh,
    readFileSync(SH_INSTALLER, 'utf8').replace(
      /^PINNED_TRUST_ROOT_PEM="[^"]*"$/m,
      `PINNED_TRUST_ROOT_PEM="${SENTINEL}"`,
    ),
  );
  writeFileSync(
    ps1,
    readFileSync(PS1_INSTALLER, 'utf8').replace(
      /^\$script:PinnedTrustRootPem = '[^']*'$/m,
      `$script:PinnedTrustRootPem = '${SENTINEL}'`,
    ),
  );
  return { sh, ps1 };
}

/** A runtime Ed25519 public key as SPKI PEM, plus its SPKI SHA-256 fingerprint. */
function ed25519PublicKey(dir: string, name: string): { path: string; pem: string; fingerprint: string } {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const path = join(dir, name);
  writeFileSync(path, pem);
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  return { path, pem: pem.trim(), fingerprint };
}

async function runTool(args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const result = await spawnAsync(process.execPath, [TOOL, ...args], { timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function snapshot(paths: readonly string[]): string[] {
  return paths.map((p) => readFileSync(p, 'utf8'));
}

interface Job {
  needs?: string | string[];
  steps?: Array<{ run?: string; uses?: string }>;
}

function loadJobs(file: string): Record<string, Job> {
  const doc = yaml.load(readFileSync(join(WORKFLOWS, file), 'utf8')) as { jobs?: Record<string, Job> };
  return doc.jobs ?? {};
}

function needsOf(job: Job | undefined): string[] {
  if (job?.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

describe('pin-trust-root.mjs', () => {
  it('PinTrustRoot_SeededSentinel_CheckRefuses', async () => {
    const { sh, ps1 } = seededCopies(scratch());
    const result = await runTool(['--check', sh, ps1]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('not pinned');
    expect(result.stderr).toContain(SENTINEL);
  });

  it('PinTrustRoot_RuntimeEd25519Key_ReplacesOnlyTheSentinelAndCheckAccepts', async () => {
    const dir = scratch();
    const { sh, ps1 } = seededCopies(dir);
    const before = snapshot([sh, ps1]);
    const key = ed25519PublicKey(dir, 'publisher.pub.pem');

    const pinned = await runTool([key.path, sh, ps1]);
    expect(pinned.status, pinned.stderr).toBe(0);
    expect(pinned.stdout).toContain(key.fingerprint);

    const after = snapshot([sh, ps1]);
    for (let i = 0; i < after.length; i++) {
      expect(after[i]).toBe(before[i]?.replace(SENTINEL, key.pem));
      expect(after[i]).not.toContain(SENTINEL);
    }

    const checked = await runTool(['--check', sh, ps1]);
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout).toContain(key.fingerprint);
  });

  it.skipIf(process.platform === 'win32')(
    'PinTrustRoot_PinnedShInstaller_MaterializesThePinnedKey',
    async () => {
      const dir = scratch();
      const { sh, ps1 } = seededCopies(dir);
      const key = ed25519PublicKey(dir, 'publisher.pub.pem');
      expect((await runTool([key.path, sh, ps1])).status).toBe(0);

      const env: NodeJS.ProcessEnv = { ...process.env, EXARCHOS_LIB_ONLY: '1', INSTALLER: sh, WORK: dir };
      delete env['EXARCHOS_TRUST_ROOT_PEM_FILE'];
      const result = await spawnAsync('bash', ['-c', '. "$INSTALLER" && resolve_trust_root_pem "$WORK"'], {
        env,
        timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(0);
      const written = readFileSync(result.stdout.trim(), 'utf8');
      expect(written).toBe(`${key.pem}\n`);
      expect(createPublicKey(written).asymmetricKeyType).toBe('ed25519');
    },
  );

  it('PinTrustRoot_PinnedPs1Installer_MaterializesThePinnedKey', async () => {
    let pwsh: string | undefined;
    for (const exe of ['pwsh', 'powershell']) {
      if ((await spawnAsync(exe, ['-NoProfile', '-Command', 'exit 0'], { timeout: 20_000 })).status === 0) {
        pwsh = exe;
        break;
      }
    }
    if (pwsh === undefined) {
      expect(IS_CI, 'CI must provide pwsh to prove the pinned .ps1 installer').toBe(false);
      return;
    }
    const dir = scratch();
    const { sh, ps1 } = seededCopies(dir);
    const key = ed25519PublicKey(dir, 'publisher.pub.pem');
    expect((await runTool([key.path, sh, ps1])).status).toBe(0);

    const env: NodeJS.ProcessEnv = { ...process.env, INSTALLER: ps1, WORK: dir };
    delete env['EXARCHOS_TRUST_ROOT_PEM_FILE'];
    const result = await spawnAsync(
      pwsh,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '. $env:INSTALLER -LoadOnly; $p = Resolve-TrustRootPem -WorkDir $env:WORK; [Console]::Out.Write($p)',
      ],
      { env, timeout: 60_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const written = readFileSync(result.stdout.trim(), 'utf8').replace(/\r\n/g, '\n');
    expect(written.trim()).toBe(key.pem);
  }, 90_000);

  it('PinTrustRoot_NonEd25519Key_RefusedAndNothingWritten', async () => {
    const dir = scratch();
    const { sh, ps1 } = seededCopies(dir);
    const before = snapshot([sh, ps1]);
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ecPath = join(dir, 'ec.pub.pem');
    writeFileSync(ecPath, publicKey.export({ type: 'spki', format: 'pem' }));

    const result = await runTool([ecPath, sh, ps1]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Ed25519');
    expect(snapshot([sh, ps1])).toEqual(before);
  });

  it('PinTrustRoot_PrivateKey_RefusedWithoutEchoingIt', async () => {
    const dir = scratch();
    const { sh, ps1 } = seededCopies(dir);
    const before = snapshot([sh, ps1]);
    const { privateKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const privatePath = join(dir, 'throwaway.key.pem');
    writeFileSync(privatePath, privatePem, { mode: 0o600 });

    const result = await runTool([privatePath, sh, ps1]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PRIVATE key');
    const body = privatePem.split('\n')[1] ?? '';
    expect(body.length).toBeGreaterThan(20);
    expect(`${result.stdout}${result.stderr}`).not.toContain(body);
    expect(snapshot([sh, ps1])).toEqual(before);
  });

  it('PinTrustRoot_OneInstallerAlreadyPinned_RefusesAndWritesNeither', async () => {
    const dir = scratch();
    const { sh, ps1 } = seededCopies(dir);
    const first = ed25519PublicKey(dir, 'first.pub.pem');
    expect((await runTool([first.path, ps1])).status).toBe(0);
    const before = snapshot([sh, ps1]);

    const second = ed25519PublicKey(dir, 'second.pub.pem');
    const result = await runTool([second.path, sh, ps1]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exactly once');
    expect(snapshot([sh, ps1])).toEqual(before);
    expect(before[0]).toContain(SENTINEL);
  });

  it('PinTrustRoot_InstallersPinDifferentKeys_CheckRefuses', async () => {
    const dir = scratch();
    const { sh, ps1 } = seededCopies(dir);
    expect((await runTool([ed25519PublicKey(dir, 'a.pub.pem').path, sh])).status).toBe(0);
    expect((await runTool([ed25519PublicKey(dir, 'b.pub.pem').path, ps1])).status).toBe(0);

    const result = await runTool(['--check', sh, ps1]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('different keys');
  });
});

describe('release gate on the unpinned trust root', () => {
  it('ReleaseWorkflow_TrustRootGate_PrecedesEveryPublishingJob', () => {
    const jobs = loadJobs('release.yml');
    const gates = Object.entries(jobs)
      .filter(([, job]) => (job.steps ?? []).some((s) => /pin-trust-root\.mjs\s+--check\b/.test(s.run ?? '')))
      .map(([id]) => id);
    expect(gates.length).toBeGreaterThan(0);

    const publishing = Object.entries(jobs)
      .filter(([, job]) =>
        (job.steps ?? []).some(
          (s) => /\bnpm publish\b/.test(s.run ?? '') || (s.uses ?? '').startsWith('softprops/action-gh-release@'),
        ),
      )
      .map(([id]) => id);
    expect(publishing).toEqual(expect.arrayContaining(['publish-release', 'release']));

    for (const id of publishing) {
      const seen = new Set<string>();
      const queue = needsOf(jobs[id]);
      while (queue.length > 0) {
        const next = queue.shift() as string;
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(...needsOf(jobs[next]));
      }
      expect(
        gates.some((gate) => seen.has(gate)),
        `release.yml job '${id}' publishes without depending on the trust-root gate`,
      ).toBe(true);
    }
  });

  it('Workflows_OnlyTheReleaseWorkflowRunsTheTrustRootGate', () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    expect(files).toContain('ci.yml');
    const offenders = files.filter(
      (f) => f !== 'release.yml' && /pin-trust-root\.mjs\s+--check\b/.test(readFileSync(join(WORKFLOWS, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
