/**
 * Builds the deterministic proof fixtures that downstream consumers verify against.
 * A fixture holds per-action digests of the descriptor, schemas and policy, the whole-contract
 * digest, and the authority snapshot that gated generation. An oracle re-derives the bundle and
 * compares it, so a registry edit to a schema or a policy changes a digest and fails the comparison.
 */

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
  /**
   * `sha256:` over the action's canonical action contract. Omitted when the
   * action has no declared contract — never invented from annotations.
   */
  readonly actionContractDigest?: string;
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
 * Builds the proof fixtures for a compiled contract. Every digest is over canonical JSON, so the
 * bundle is byte-stable. Actions are sorted by ActionId for a stable diff.
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
      const actionContractDigest =
        d.actionContract === undefined
          ? undefined
          : digestText(canonicalJson(d.actionContract));
      return {
        actionId: d.actionId,
        descriptorDigest: d.digest,
        inputSchemaDigest,
        outputSchemaDigest,
        policyDigest: digestText(canonicalJson(d.policy)),
        ...(actionContractDigest === undefined ? {} : { actionContractDigest }),
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
