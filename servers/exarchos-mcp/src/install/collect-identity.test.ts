import { describe, it, expect } from 'vitest';
import path from 'node:path';

import {
  detectInstallPosture,
  collectInstallIdentity,
  readRecordedIdentity,
  writeRecordedIdentity,
  installIdentityLockPath,
  CACHE_DESCRIPTOR_FILENAME,
  type IdentityDeps,
} from './collect-identity.js';
import { resolveCacheDir } from '../utils/paths.js';
import { InstallIdentitySchema } from './install-identity.js';
import { SCHEMA_VERSION } from '../storage/sqlite-backend.js';

// ─── In-memory filesystem seams ──────────────────────────────────────────────

/** Build injectable read seams from a path→content map (keys are exact paths). */
function readSeams(files: ReadonlyMap<string, string>): Pick<IdentityDeps, 'readFileText' | 'readTree' | 'pathExists'> {
  return {
    readFileText: (p) => files.get(p),
    pathExists: (p) => {
      for (const key of files.keys()) {
        if (key === p || key.startsWith(`${p}/`) || key.startsWith(`${p}\\`)) return true;
      }
      return false;
    },
    readTree: (dir) => {
      const entries: { path: string; content: string }[] = [];
      const prefixes = [`${dir}/`, `${dir}\\`];
      for (const [key, content] of files) {
        const matched = prefixes.find((pre) => key.startsWith(pre));
        if (matched) {
          entries.push({ path: key.slice(matched.length), content });
        }
      }
      return entries;
    },
  };
}

/**
 * A coherent installed layout under `/opt/exarchos` with cache at `/opt/cache`,
 * built so the map keys are the EXACT paths the collector will request
 * (computed via the same `path.join` / `resolveCacheDir` the production code
 * uses, so the fixture matches on any platform).
 */
const PLUGIN_ROOT = '/opt/exarchos';
const ENV = { EXARCHOS_CACHE_DIR: '/opt/cache' } as const;

function cacheDescriptorPath(): string {
  return path.join(resolveCacheDir({ env: ENV, homedir: '/home/u' }), CACHE_DESCRIPTOR_FILENAME);
}

function coherentFiles(overrides?: Partial<{
  pkg: string;
  manifest: string;
  skill: string;
  cache: string;
}>): Map<string, string> {
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

function collectFrom(files: Map<string, string>) {
  return collectInstallIdentity(PLUGIN_ROOT, { env: ENV, homedir: '/home/u', ...readSeams(files) });
}

// ─── detectInstallPosture ─────────────────────────────────────────────────────

describe('detectInstallPosture', () => {
  it('installed via EXARCHOS_PLUGIN_ROOT', () => {
    const posture = detectInstallPosture({ env: { EXARCHOS_PLUGIN_ROOT: '/plug' }, homedir: '/home/u' });
    expect(posture).toEqual({ kind: 'installed', pluginRoot: '/plug', source: 'env-exarchos' });
  });

  it('installed via CLAUDE_PLUGIN_ROOT', () => {
    const posture = detectInstallPosture({ env: { CLAUDE_PLUGIN_ROOT: '/cplug' }, homedir: '/home/u' });
    expect(posture).toEqual({ kind: 'installed', pluginRoot: '/cplug', source: 'env-claude' });
  });

  it('installed via Claude plugin cache directory', () => {
    const cacheRoot = path.join('/home/u', '.claude', 'plugins', 'cache', 'lvlup-sw', 'exarchos');
    const posture = detectInstallPosture({
      env: {},
      homedir: '/home/u',
      pathExists: (p) => p === cacheRoot,
    });
    expect(posture).toEqual({ kind: 'installed', pluginRoot: cacheRoot, source: 'claude-cache' });
  });

  it('dev-checkout when no plugin root and no cache — a source checkout is NOT a corrupt install', () => {
    const posture = detectInstallPosture({ env: {}, homedir: '/home/u', pathExists: () => false });
    expect(posture.kind).toBe('dev-checkout');
  });

  it('empty/whitespace plugin-root env does not count as installed', () => {
    const posture = detectInstallPosture({
      env: { EXARCHOS_PLUGIN_ROOT: '   ', CLAUDE_PLUGIN_ROOT: '' },
      homedir: '/home/u',
      pathExists: () => false,
    });
    expect(posture.kind).toBe('dev-checkout');
  });
});

// ─── collectInstallIdentity ───────────────────────────────────────────────────

describe('collectInstallIdentity', () => {
  it('materializes a schema-valid identity from disk', () => {
    const id = collectFrom(coherentFiles());
    expect(() => InstallIdentitySchema.parse(id)).not.toThrow();
    expect(id.binary.version).toBe('2.11.0');
    expect(id.schema.version).toBe(SCHEMA_VERSION);
    expect(id.cache.location).toBe(resolveCacheDir({ env: ENV, homedir: '/home/u' }));
  });

  it('is deterministic — identical inputs produce an identical record', () => {
    expect(collectFrom(coherentFiles())).toEqual(collectFrom(coherentFiles()));
  });

  it('binary digest changes when package.json changes but other dimensions do not', () => {
    const base = collectFrom(coherentFiles());
    const changed = collectFrom(coherentFiles({ pkg: JSON.stringify({ name: 'exarchos', version: '2.12.0' }) }));
    expect(changed.binary).not.toEqual(base.binary);
    expect(changed.plugin).toEqual(base.plugin);
    expect(changed.skill).toEqual(base.skill);
    expect(changed.cache).toEqual(base.cache);
  });

  it('plugin digest changes when the manifest changes but other dimensions do not', () => {
    const base = collectFrom(coherentFiles());
    const changed = collectFrom(coherentFiles({ manifest: JSON.stringify({ name: 'exarchos', commands: ['wf', 'x'] }) }));
    expect(changed.plugin).not.toEqual(base.plugin);
    expect(changed.binary).toEqual(base.binary);
    expect(changed.skill).toEqual(base.skill);
  });

  it('skill digest changes when a rendered skill changes but other dimensions do not', () => {
    const base = collectFrom(coherentFiles());
    const changed = collectFrom(coherentFiles({ skill: '# Skill A\nDIFFERENT body\n' }));
    expect(changed.skill).not.toEqual(base.skill);
    expect(changed.binary).toEqual(base.binary);
    expect(changed.plugin).toEqual(base.plugin);
  });

  it('cache digest changes when the descriptor changes but other dimensions do not', () => {
    const base = collectFrom(coherentFiles());
    const changed = collectFrom(coherentFiles({ cache: JSON.stringify({ owner: 'exarchos@2.12.0', format: 1 }) }));
    expect(changed.cache).not.toEqual(base.cache);
    expect(changed.binary).toEqual(base.binary);
  });

  it('falls back to manifest.json when .claude-plugin/plugin.json is absent', () => {
    const files = new Map<string, string>([
      [path.join(PLUGIN_ROOT, 'package.json'), JSON.stringify({ version: '2.11.0' })],
      [path.join(PLUGIN_ROOT, 'manifest.json'), JSON.stringify({ name: 'mkt' })],
      [cacheDescriptorPath(), '{}'],
    ]);
    const withManifest = collectInstallIdentity(PLUGIN_ROOT, { env: ENV, homedir: '/home/u', ...readSeams(files) });
    // Same manifest content under plugin.json must yield the same plugin digest.
    const viaPlugin = collectFrom(coherentFiles({ manifest: JSON.stringify({ name: 'mkt' }) }));
    expect(withManifest.plugin).toEqual(viaPlugin.plugin);
  });

  it('substitutes a deterministic sentinel version when package.json is missing', () => {
    const files = new Map<string, string>([[cacheDescriptorPath(), '{}']]);
    const id = collectInstallIdentity(PLUGIN_ROOT, { env: ENV, homedir: '/home/u', ...readSeams(files) });
    expect(id.binary.version).toBe('0.0.0-unknown');
    expect(() => InstallIdentitySchema.parse(id)).not.toThrow();
  });
});

// ─── recorded lock read/write ─────────────────────────────────────────────────

describe('recorded install-identity lock', () => {
  it('readRecordedIdentity returns undefined when no lock exists (first run)', () => {
    expect(readRecordedIdentity('/state', { readFileText: () => undefined })).toBeUndefined();
  });

  it('readRecordedIdentity returns undefined for corrupt JSON (heals via re-record)', () => {
    expect(readRecordedIdentity('/state', { readFileText: () => 'not json {' })).toBeUndefined();
  });

  it('readRecordedIdentity returns undefined for schema-invalid content', () => {
    expect(
      readRecordedIdentity('/state', { readFileText: () => JSON.stringify({ binary: { version: 'x' } }) }),
    ).toBeUndefined();
  });

  it('write→read round-trips the identity', () => {
    const store = new Map<string, string>();
    const deps: IdentityDeps = {
      writeFileText: (p, c) => { store.set(p, c); },
      mkdirp: () => {},
      readFileText: (p) => store.get(p),
    };
    const id = collectFrom(coherentFiles());
    writeRecordedIdentity('/state', id, deps);
    expect(store.has(installIdentityLockPath('/state'))).toBe(true);
    expect(readRecordedIdentity('/state', deps)).toEqual(id);
  });
});
