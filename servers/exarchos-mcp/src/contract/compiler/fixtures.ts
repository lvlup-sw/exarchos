// ─── Proof fixtures (P03-03) ─────────────────────────────────────────────────
//
// PROGRAM-03, API-003. Emits the deterministic, content-addressed fixtures the
// DOWNSTREAM packages verify against: P03-04 (MCP registration/bindings), P03-05
// (the generated CLI client), and P03-09 (the independent oracle). A fixture is
// the compiler's byte-stable claim about the compiled contract — the per-action
// descriptor/schema/policy digests plus the whole-contract digest and the
// authority snapshot that gated generation.
//
// The bundle is what an oracle re-derives independently and compares: if a later
// registry edit changes an action's schema or policy, the corresponding fixture
// digest changes and the oracle's comparison fails loudly. The checked-in
// fixture is therefore the review artifact for contract drift.
// ────────────────────────────────────────────────────────────────────────────

import { digestText } from '../authority-digest.js';
import { canonicalJson } from '../request-context.js';
import type { ActionDescriptor, SchemaBundle } from './descriptors.js';

/** The gating authority snapshot recorded in a fixture (deterministic subset). */
export interface AuthoritySnapshot {
  readonly ok: boolean;
  readonly authorityIds: readonly string[];
}

export interface ActionFixture {
  readonly actionId: string;
  readonly descriptorDigest: string;
  readonly inputSchemaDigest: string;
  readonly outputSchemaDigest: string;
  readonly policyDigest: string;
  readonly errorCodes: readonly string[];
  readonly outputKinds: readonly string[];
}

export interface ProofFixtureBundle {
  readonly fixtureVersion: 1;
  readonly surfaceVersion: string;
  readonly authority: AuthoritySnapshot;
  /** `sha256:` over the whole compiled contract (descriptors + schemas + types + report). */
  readonly contractDigest: string;
  readonly actions: readonly ActionFixture[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Build the proof fixtures for a compiled contract. Every digest is derived over
 * canonical JSON so the bundle is byte-stable and platform-independent; actions
 * are sorted by ActionId for a stable diff.
 */
export function buildProofFixtures(
  surfaceVersion: string,
  descriptors: readonly ActionDescriptor[],
  schemas: SchemaBundle,
  contractDigest: string,
  authority: AuthoritySnapshot,
): ProofFixtureBundle {
  const actions: ActionFixture[] = descriptors
    .map((d): ActionFixture => {
      const schemaPair = schemas.actions[d.actionId];
      const inputSchemaDigest = schemaPair ? digestText(canonicalJson(schemaPair.input)) : 'sha256:absent';
      const outputSchemaDigest = schemaPair
        ? digestText(canonicalJson(schemaPair.output))
        : 'sha256:absent';
      return {
        actionId: d.actionId,
        descriptorDigest: d.digest,
        inputSchemaDigest,
        outputSchemaDigest,
        policyDigest: digestText(canonicalJson(d.policy)),
        errorCodes: d.errorCodes,
        outputKinds: d.outputKinds,
      };
    })
    .sort((a, b) => byString(a.actionId, b.actionId));

  return {
    fixtureVersion: 1,
    surfaceVersion,
    authority: {
      ok: authority.ok,
      authorityIds: [...authority.authorityIds].sort(byString),
    },
    contractDigest,
    actions,
  };
}

/** The canonical, byte-stable serialization of a fixture bundle. */
export function serializeProofFixtures(bundle: ProofFixtureBundle): string {
  return canonicalJson(bundle);
}
