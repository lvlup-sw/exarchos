import { describe, it, expect } from 'vitest';
import {
  buildInstallIdentity,
  digestText,
  digestTree,
  normalizeLineEndings,
  normalizePath,
  InstallIdentitySchema,
  type RawInstallInputs,
} from '../../../src/install/install-identity.js';

// ─── Digest determinism + cross-platform normalization (P05-04) ─────────────

describe('install-identity digest primitives', () => {
  it('normalizeLineEndings collapses CRLF and lone CR to LF and strips BOM', () => {
    expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    expect(normalizeLineEndings('\uFEFFhead')).toBe('head');
  });

  it('digestText is line-ending invariant (Windows CRLF == Linux LF)', () => {
    expect(digestText('line1\r\nline2\r\n')).toBe(digestText('line1\nline2\n'));
  });

  it('digestText distinguishes genuinely different content', () => {
    expect(digestText('alpha')).not.toBe(digestText('beta'));
  });

  it('digestText emits the sha256:<hex> shape', () => {
    expect(digestText('x')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('digestTree is order-independent', () => {
    const a = digestTree([
      { path: 'a.txt', content: '1' },
      { path: 'b.txt', content: '2' },
    ]);
    const b = digestTree([
      { path: 'b.txt', content: '2' },
      { path: 'a.txt', content: '1' },
    ]);
    expect(a).toBe(b);
  });

  it('digestTree is path-separator invariant (Windows backslash == POSIX slash)', () => {
    const win = digestTree([{ path: 'skills\\claude\\a\\SKILL.md', content: 'body\r\n' }]);
    const posix = digestTree([{ path: 'skills/claude/a/SKILL.md', content: 'body\n' }]);
    expect(win).toBe(posix);
  });

  it('digestTree does not collide on path/content boundary shifts', () => {
    const one = digestTree([{ path: 'a', content: 'b' }]);
    const two = digestTree([{ path: 'ab', content: '' }]);
    expect(one).not.toBe(two);
  });

  it('digestTree reflects a content change in any entry', () => {
    const base = digestTree([{ path: 'a', content: 'x' }]);
    const changed = digestTree([{ path: 'a', content: 'y' }]);
    expect(base).not.toBe(changed);
  });

  it('normalizePath rewrites backslashes to slashes', () => {
    expect(normalizePath('C:\\a\\b')).toBe('C:/a/b');
  });
});

// ─── buildInstallIdentity (P05-04) ──────────────────────────────────────────

const BASE_RAW: RawInstallInputs = {
  binaryVersion: '2.12.0',
  binaryEntries: [{ path: 'bin/exarchos', content: 'BINARY-BYTES' }],
  pluginManifest: '{"name":"exarchos","version":"2.12.0"}',
  skillEntries: [{ path: 'skills/claude/a/SKILL.md', content: 'skill a\n' }],
  schemaVersion: 6,
  cacheLocation: '/home/u/.exarchos/cache',
  cacheEntries: [{ path: 'index.json', content: '{}' }],
};

describe('buildInstallIdentity', () => {
  it('produces a schema-valid, fully-populated record', () => {
    const id = buildInstallIdentity(BASE_RAW);
    expect(() => InstallIdentitySchema.parse(id)).not.toThrow();
    expect(id.binary.version).toBe('2.12.0');
    expect(id.schema.version).toBe(6);
    expect(id.cache.location).toBe('/home/u/.exarchos/cache');
    expect(id.binary.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id.plugin.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id.skill.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id.cache.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic across CRLF/LF and separator variations of the same content', () => {
    const windowsAuthored = buildInstallIdentity({
      ...BASE_RAW,
      pluginManifest: '{"name":"exarchos"}\r\n',
      skillEntries: [{ path: 'skills\\claude\\a\\SKILL.md', content: 'skill a\r\n' }],
      cacheLocation: 'C:/home/u/.exarchos/cache',
    });
    const linuxRendered = buildInstallIdentity({
      ...BASE_RAW,
      pluginManifest: '{"name":"exarchos"}\n',
      skillEntries: [{ path: 'skills/claude/a/SKILL.md', content: 'skill a\n' }],
      cacheLocation: 'C:/home/u/.exarchos/cache',
    });
    expect(windowsAuthored.plugin.manifestDigest).toBe(linuxRendered.plugin.manifestDigest);
    expect(windowsAuthored.skill.digest).toBe(linuxRendered.skill.digest);
  });

  it('rejects an empty binary version via schema validation', () => {
    expect(() => buildInstallIdentity({ ...BASE_RAW, binaryVersion: '' })).toThrow();
  });
});
