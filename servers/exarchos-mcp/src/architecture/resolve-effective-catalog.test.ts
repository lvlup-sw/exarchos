import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveEffectiveCatalog } from './resolve-effective-catalog.js';
import type { ExarchosConfig } from '../config/exarchos-config-schema.js';

/**
 * Build an isolated repo fixture with a dev invariants catalog at
 * `docs/architecture/invariants.md` and a user-authored catalog. Returns the
 * temp repo root; caller is responsible for cleanup.
 */
function makeRepoFixture(): {
  repoRoot: string;
  userCatalogPath: string;
  cleanup: () => void;
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-cat-'));
  const archDir = path.join(repoRoot, 'docs', 'architecture');
  fs.mkdirSync(archDir, { recursive: true });

  // Dev catalog (built-in). schema-version 3 so phase/workflow affinity and
  // integrity-class fields are honoured.
  const devCatalog = [
    '---',
    'schema-version: 3',
    'invariants:',
    '  - id: INV-1',
    '    dimension: substrate-truth',
    '    axis: substrate',
    '    integrity-class: substrate',
    '    cost-of-load: always-load',
    '    applies-to:',
    '      - src/**',
    '    summary: Payload is the single source of truth.',
    '    references: []',
    '---',
    '# Dev catalog body',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(archDir, 'invariants.md'), devCatalog, 'utf8');

  // User catalog (consumer-authored). A non-reserved id, sdlc-removable
  // semantics handled by the merge layer (tagged `user`, no floor).
  const userCatalog = [
    '---',
    'schema-version: 3',
    'invariants:',
    '  - id: team-no-console',
    '    dimension: lint',
    '    axis: substrate',
    '    cost-of-load: always-load',
    '    applies-to:',
    '      - src/**',
    '    summary: No console.log in committed code.',
    '    references: []',
    '  - id: team-doc-style',
    '    dimension: docs',
    '    axis: authoring',
    '    cost-of-load: always-load',
    '    applies-to:',
    '      - docs/**',
    '    summary: Docs follow the house style.',
    '    references: []',
    '---',
    '# User catalog body',
    '',
  ].join('\n');
  const userCatalogPath = path.join(repoRoot, 'team-invariants.md');
  fs.writeFileSync(userCatalogPath, userCatalog, 'utf8');

  return {
    repoRoot,
    userCatalogPath,
    cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }),
  };
}

describe('resolveEffectiveCatalog', () => {
  let fixture: ReturnType<typeof makeRepoFixture>;

  beforeEach(() => {
    fixture = makeRepoFixture();
  });

  afterEach(() => {
    fixture.cleanup();
    vi.restoreAllMocks();
  });

  it('ResolveEffectiveCatalog_DevSdlcUser_ReturnsMergedProjectedPayload', () => {
    const config: ExarchosConfig = {
      invariants: {
        devCatalog: 'enabled',
        catalogs: [fixture.userCatalogPath],
        // `team-no-console` is a user-layer entry (no floor) → a disable
        // override is honored and the entry is dropped from the payload.
        overrides: {
          'team-no-console': { enabled: false },
        },
      },
    };

    const { entries } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'ideate',
      workflowType: 'feature',
    });

    const ids = entries.map((e) => e.id);

    // Dev-layer substrate invariant is present (devCatalog enabled).
    expect(ids).toContain('INV-1');
    // User-layer entry that was NOT disabled remains.
    expect(ids).toContain('team-doc-style');
    // A disabled-with-permission (user floor = none) entry is absent.
    expect(ids).not.toContain('team-no-console');
  });
});
