import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleViewInvariantsEffective } from '../../../../src/projections/views/effective-catalog.js';
import { resolveEffectiveCatalog } from '../../../../src/architecture/resolve-effective-catalog.js';
import { loadExarchosConfig } from '../../../../src/config/load-exarchos-config.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

/**
 * Builds a repo fixture with a user catalog and an `.exarchos.yml` that registers it and disables one entry.
 * The fixture also writes `docs/architecture/invariants.md`, but the config does not register that file.
 * The view handler reads the config from disk, so the handler and the core function see the same state.
 */
function makeRepoFixture(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'view-eff-cat-'));
  const archDir = path.join(repoRoot, 'docs', 'architecture');
  fs.mkdirSync(archDir, { recursive: true });

  fs.writeFileSync(
    path.join(archDir, 'invariants.md'),
    [
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
      '# body',
      '',
    ].join('\n'),
    'utf8',
  );

  fs.writeFileSync(
    path.join(repoRoot, 'team-invariants.md'),
    [
      '---',
      'schema-version: 3',
      'invariants:',
      '  - id: team-no-console',
      '    dimension: lint',
      '    axis: substrate',
      '    cost-of-load: always-load',
      '    applies-to:',
      '      - src/**',
      '    summary: No console.log.',
      '    references: []',
      '  - id: team-doc-style',
      '    dimension: docs',
      '    axis: authoring',
      '    cost-of-load: always-load',
      '    applies-to:',
      '      - docs/**',
      '    summary: House docs style.',
      '    references: []',
      '---',
      '# body',
      '',
    ].join('\n'),
    'utf8',
  );

  fs.writeFileSync(
    path.join(repoRoot, '.exarchos.yml'),
    [
      'invariants:',
      '  catalogs:',
      '    - team-invariants.md',
      '  overrides:',
      '    team-no-console:',
      '      enabled: false',
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    repoRoot,
    cleanup: () => rmrf(repoRoot),
  };
}

describe('handleViewInvariantsEffective', () => {
  let fixture: ReturnType<typeof makeRepoFixture>;

  beforeEach(() => {
    fixture = makeRepoFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  /** The view must return the same payload as the core function for the same context. */
  it('ViewInvariants_Export_ReturnsSamePayloadAsCoreFn', async () => {
    const args = {
      repoRoot: fixture.repoRoot,
      phase: 'ideate',
      workflowType: 'feature',
    };

    const result = await handleViewInvariantsEffective(args);
    expect(result.success).toBe(true);

    const loaded = loadExarchosConfig(fixture.repoRoot, {
      findRepoRoot: () => fixture.repoRoot,
    });
    const core = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config: loaded?.config,
      phase: 'ideate',
      workflowType: 'feature',
    });

    expect(result.data).toEqual(core);
  });

  /** The default SDLC baseline must reach the view through the one core function, with the same entries. */
  it('ViewInvariants_ReviewPhase_SurfacesSdlcBaselineIdenticalToCoreFn', async () => {
    const args = {
      repoRoot: fixture.repoRoot,
      phase: 'review',
      workflowType: 'feature',
    };
    const result = await handleViewInvariantsEffective(args);
    expect(result.success).toBe(true);
    const data = result.data as { entries: Array<{ id: string }> };
    expect(data.entries.some((e) => e.id === 'SDLC-1')).toBe(true);

    const loaded = loadExarchosConfig(fixture.repoRoot, {
      findRepoRoot: () => fixture.repoRoot,
    });
    const core = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config: loaded?.config,
      phase: 'review',
      workflowType: 'feature',
    });
    expect(result.data).toEqual(core);
  });
});
