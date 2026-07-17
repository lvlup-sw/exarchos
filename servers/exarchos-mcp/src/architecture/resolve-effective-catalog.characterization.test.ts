import { describe, it, expect } from 'vitest';
import { resolveEffectiveCatalog } from './resolve-effective-catalog.js';
import type { ExarchosConfigInput } from '../config/exarchos-config-schema.js';

/**
 * Characterization guard for the dev-catalog migration (P1, T0).
 *
 * This test PINS today's behavior of the `devCatalog: 'enabled'` path against
 * the REAL repo `docs/architecture/invariants.md`. It is the golden expectation
 * the P1 refactor (T3/T4) must preserve: collapsing the hardcoded Layer-1 block
 * into a registered-source loop is a PURE refactor, so the resolved INV-* entry
 * ids and their tier/integrity-class tags must not change.
 *
 * The snapshot intentionally captures ONLY the dev-layer (`INV-*`) entries: the
 * sdlc inline layer (`SDLC-*`) is exercised elsewhere and is out of scope for
 * the dev migration. We sort by id for a stable, order-independent golden.
 */
describe('resolveEffectiveCatalog — dev-catalog characterization (T0)', () => {
  it('resolveEffectiveCatalog_DevCatalogEnabled_GoldenSnapshot', () => {
    const config: ExarchosConfigInput = {
      invariants: { devCatalog: 'enabled' },
    };

    // No `repoRoot` override: resolve against the real repo catalog via the
    // module-relative default (four levels up from src/architecture/), the same
    // path the running gate uses inside this repo.
    const { entries } = resolveEffectiveCatalog({
      config,
      // Use a permissive phase/workflow so the projection retains every
      // dev-layer entry whose affinity matches a broad context. `ideate` +
      // `feature` is the canonical broad working set.
      phase: 'ideate',
      workflowType: 'feature',
    });

    // Capture only the dev-layer (INV-*) entries' identity + tags. SDLC-* and
    // any user entries are excluded so the golden reflects the migration target.
    const devSnapshot = entries
      .filter((e) => e.id.startsWith('INV-'))
      .map((e) => ({
        id: e.id,
        integrityClass: e.integrityClass,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(devSnapshot).toMatchSnapshot();
  });
});
