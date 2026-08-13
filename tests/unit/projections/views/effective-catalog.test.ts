import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleViewInvariantsEffective } from '../../../../src/projections/views/effective-catalog.js';
import { resolveEffectiveCatalog } from '../../../../src/architecture/resolve-effective-catalog.js';
import { loadExarchosConfig } from '../../../../src/config/load-exarchos-config.js';

/**
 * Build a repo fixture with a committed `.exarchos.yml` (a registered user
 * catalog +
 * a user catalog + an override), a dev invariants catalog, and a user
 * catalog. The view facade reads the config from disk exactly as production
 * would, so the test drives both facades from the same on-disk state.
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
    cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }),
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

  it('ViewInvariants_Export_ReturnsSamePayloadAsCoreFn', async () => {
    const args = {
      repoRoot: fixture.repoRoot,
      phase: 'ideate',
      workflowType: 'feature',
    };

    // Facade payload (the CLI `--json` form routes the same handler).
    const result = await handleViewInvariantsEffective(args);
    expect(result.success).toBe(true);

    // Core-fn payload for the same ctx — the view must NOT recompute, it must
    // surface byte-identical output (INV-2).
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

  it('ViewInvariants_ReviewPhase_SurfacesSdlcBaselineIdenticalToCoreFn', async () => {
    // #1467: the default-on SDLC-* baseline must reach the view facade (and the
    // CLI `--json` form) identically to the gate's resolved catalog — proving
    // the now-non-empty sdlc layer flows through the single core fn (INV-2).
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
