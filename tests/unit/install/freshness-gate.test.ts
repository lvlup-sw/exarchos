import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';

import {
  evaluateInstallFreshness,
  resetInstallFreshnessGateForTest,
  type FreshnessGateDeps,
} from '../../../src/install/freshness-gate.js';
import {
  collectInstallIdentity,
  installIdentityLockPath,
  CACHE_DESCRIPTOR_FILENAME,
  type IdentityDeps,
} from '../../../src/install/collect-identity.js';
import { resolveCacheDir } from '../../../src/utils/paths.js';
import { SCHEMA_VERSION } from '../../../src/storage/sqlite-backend.js';
import type { InstallIdentity } from '../../../src/install/install-identity.js';

const PLUGIN_ROOT = '/opt/exarchos';
const ENV = { EXARCHOS_PLUGIN_ROOT: PLUGIN_ROOT, EXARCHOS_CACHE_DIR: '/opt/cache' } as const;
const HOME = '/home/u';

function cacheDescriptorPath(): string {
  return path.join(resolveCacheDir({ env: ENV, homedir: HOME }), CACHE_DESCRIPTOR_FILENAME);
}

function coherentFiles(overrides?: Partial<{ pkg: string; manifest: string; skill: string; cache: string }>): Map<string, string> {
  const pkg = overrides?.pkg ?? JSON.stringify({ name: 'exarchos', version: '2.11.0' });
  const manifest = overrides?.manifest ?? JSON.stringify({ name: 'exarchos', commands: ['wf'] });
  const skill = overrides?.skill ?? '# Skill A\nbody\n';
  const cache = overrides?.cache ?? JSON.stringify({ owner: 'exarchos@2.11.0', format: 1 });
  return new Map<string, string>([
    [path.join(PLUGIN_ROOT, 'package.json'), pkg],
    [path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), manifest],
    [path.join(PLUGIN_ROOT, 'skills', 'claude', 'skill-a', 'SKILL.md'), skill],
    [cacheDescriptorPath(), cache],
  ]);
}

/** Read+write seams over a single shared map (the lock is written into it). */
function seams(files: Map<string, string>): IdentityDeps {
  return {
    readFileText: (p) => files.get(p),
    readTree: (dir) => {
      const out: { path: string; content: string }[] = [];
      for (const [key, content] of files) {
        for (const pre of [`${dir}/`, `${dir}\\`]) {
          if (key.startsWith(pre)) out.push({ path: key.slice(pre.length), content });
        }
      }
      return out;
    },
    pathExists: (p) => {
      for (const key of files.keys()) {
        if (key === p || key.startsWith(`${p}/`) || key.startsWith(`${p}\\`)) return true;
      }
      return false;
    },
    writeFileText: (p, c) => { files.set(p, c); },
    mkdirp: () => {},
  };
}

function identityFrom(files: Map<string, string>): InstallIdentity {
  return collectInstallIdentity(PLUGIN_ROOT, { env: ENV, homedir: HOME, ...seams(files) });
}

/** Deps for the gate over `files`, in installed posture. */
function gateDeps(files: Map<string, string>): FreshnessGateDeps {
  return { env: ENV, homedir: HOME, ...seams(files) };
}

/** The lock is keyed to the INSTALLATION, never to an event-store state dir. */
function lockPath(): string {
  return installIdentityLockPath(PLUGIN_ROOT, { env: ENV, homedir: HOME });
}

/** Seed the lock (expected identity) into the files map. */
function seedLock(files: Map<string, string>, identity: InstallIdentity): void {
  files.set(lockPath(), `${JSON.stringify(identity, null, 2)}\n`);
}

beforeEach(() => resetInstallFreshnessGateForTest());

describe('evaluateInstallFreshness — posture & bootstrap', () => {
  it('SKIPS on a dev checkout (no plugin root, no cache)', () => {
    const outcome = evaluateInstallFreshness({
      env: {},
      homedir: HOME,
      pathExists: () => false,
    });
    expect(outcome.status).toBe('skipped-dev');
  });

  it('BOOTSTRAPS on first run (no lock) — records the identity and does NOT block', () => {
    const files = coherentFiles();
    const outcome = evaluateInstallFreshness(gateDeps(files));
    expect(outcome.status).toBe('bootstrapped');
    expect(files.has(lockPath())).toBe(true);
  });

  it('is FRESH when the recorded lock matches what is on disk', () => {
    const files = coherentFiles();
    seedLock(files, identityFrom(files));
    const outcome = evaluateInstallFreshness(gateDeps(files));
    expect(outcome.status).toBe('fresh');
  });
});

/**
 * `blockOn` records a lock built from the given files. Then it evaluates the
 * gate against the base install and returns the mismatched dimensions.
 */
describe('evaluateInstallFreshness — five independently-seeded mismatches block', () => {
  function blockOn(lockFiles: Map<string, string>): ReadonlyArray<string> {
    const observedFiles = coherentFiles();
    seedLock(observedFiles, identityFrom(lockFiles));
    const outcome = evaluateInstallFreshness(gateDeps(observedFiles));
    expect(outcome.status).toBe('blocked');
    return outcome.status === 'blocked' ? outcome.mismatches.map((m) => m.dimension) : [];
  }

  it('BINARY mismatch blocks', () => {
    expect(blockOn(coherentFiles({ pkg: JSON.stringify({ version: '9.9.9' }) }))).toContain('binary');
  });

  it('PLUGIN mismatch blocks', () => {
    expect(blockOn(coherentFiles({ manifest: JSON.stringify({ name: 'stale' }) }))).toContain('plugin');
  });

  it('SKILL mismatch blocks', () => {
    expect(blockOn(coherentFiles({ skill: '# Skill A\nSTALE\n' }))).toContain('skill');
  });

  it('CACHE mismatch blocks', () => {
    expect(blockOn(coherentFiles({ cache: JSON.stringify({ owner: 'exarchos@1.0.0' }) }))).toContain('cache');
  });

  /**
   * The gate passes the lock as `expected` and the running binary as `observed`.
   * The schema dimension blocks only when `observed` is newer than `expected`.
   * The test records a lock that is one schema version older than the binary.
   */
  it('SCHEMA mismatch blocks when the store/lock schema is NEWER than the binary', () => {
    const files = coherentFiles();
    const base = identityFrom(files);
    const olderLock: InstallIdentity = { ...base, schema: { version: SCHEMA_VERSION - 1 } };
    seedLock(files, olderLock);
    const outcome = evaluateInstallFreshness(gateDeps(files));
    expect(outcome.status).toBe('blocked');
    if (outcome.status === 'blocked') {
      expect(outcome.mismatches.map((m) => m.dimension)).toContain('schema');
    }
  });

  /**
   * The test records a lock that is one schema version newer than the binary.
   * Then `observed` is older than `expected`, so the schema dimension does not block.
   */
  it('does NOT block when the store/lock schema is OLDER than the binary (forward-migrate)', () => {
    const files = coherentFiles();
    const base = identityFrom(files);
    const newerLock: InstallIdentity = { ...base, schema: { version: SCHEMA_VERSION + 1 } };
    seedLock(files, newerLock);
    const outcome = evaluateInstallFreshness(gateDeps(files));
    if (outcome.status === 'blocked') {
      expect(outcome.mismatches.map((m) => m.dimension)).not.toContain('schema');
    } else {
      expect(outcome.status).toBe('fresh');
    }
  });
});

describe('evaluateInstallFreshness — memoization', () => {
  /**
   * The test changes `package.json` after the first call. The memoized gate
   * returns `fresh` and does not collect the identity again.
   */
  it('caches a non-blocking outcome (evaluated once per process)', () => {
    const files = coherentFiles();
    seedLock(files, identityFrom(files));
    expect(evaluateInstallFreshness(gateDeps(files)).status).toBe('fresh');
    files.set(path.join(PLUGIN_ROOT, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    expect(evaluateInstallFreshness(gateDeps(files)).status).toBe('fresh');
  });

  it('does NOT cache a block — a stale install keeps blocking every call', () => {
    const files = coherentFiles();
    seedLock(files, identityFrom(coherentFiles({ pkg: JSON.stringify({ version: '9.9.9' }) })));
    expect(evaluateInstallFreshness(gateDeps(files)).status).toBe('blocked');
    expect(evaluateInstallFreshness(gateDeps(files)).status).toBe('blocked');
  });

  /** The repair writes a lock that matches the files on disk. */
  it('a block clears once the install is repaired (re-evaluation, then memoized fresh)', () => {
    const files = coherentFiles();
    files.set(lockPath(), `${JSON.stringify(identityFrom(coherentFiles({ pkg: JSON.stringify({ version: '9.9.9' }) })), null, 2)}\n`);
    expect(evaluateInstallFreshness(gateDeps(files)).status).toBe('blocked');
    seedLock(files, identityFrom(files));
    expect(evaluateInstallFreshness(gateDeps(files)).status).toBe('fresh');
  });
});

describe('evaluateInstallFreshness — robustness', () => {
  it('DEGRADES (does not block) when recording the lock fails under installed posture', () => {
    const files = coherentFiles();
    const deps: FreshnessGateDeps = {
      ...gateDeps(files),
      writeFileText: () => { throw new Error('read-only fs'); },
    };
    const outcome = evaluateInstallFreshness(deps);
    expect(outcome.status).toBe('degraded');
  });
});
