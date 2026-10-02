// RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28) — the composition root for the
// `outputSchema` vacuity census. It has no production importer by design, because it binds an
// instrument that governs the tool registry. Its consumers are tests and audit tools, such as the
// `output-schema-ratchet-guard` CI entrypoint. Delete it with the census.
/**
 * Bindings for the `outputSchema` vacuity census. Its five subjects are the tool registry, the
 * envelope walker, the totality predicate, the vacuity allowlist and the frozen pin.
 *
 * The allowlist stays in `src/`, because production types import `VacuityWaiverId` from it. The
 * census thus takes its data as parameters, and this module binds the live data.
 *
 * `registry.ts` is a declaration store, so this module must not import a contract module
 * (`contract/declaration.ts`, `contract/declaration-seam.ts`).
 */
import { TOOL_REGISTRY } from '../../../../src/registry.js';
import { extractEnvelopeDataSchema } from '../../../../src/verbs/worktree/schemas.js';
import { acceptsEveryValue } from '../../../../src/contract/schemas/schema-totality.js';
import {
  VACUITY_ALLOWLIST,
  VACUITY_ALLOWLIST_IDS,
  VACUITY_RETIRED_IDS,
  type VacuityWaiverEntry,
} from '../../../../src/output-schema-vacuity-allowlist.js';
import {
  VACUITY_EXPIRY_HORIZON,
  VACUITY_SEED_DIGEST_ALGORITHM,
  VACUITY_SEED_KEY_SET_DIGEST,
} from '../output-schema-seed-pin.js';
import {
  auditVacuityAllowlist,
  auditVacuityExpiry,
  auditVacuityRatchet,
  auditVacuityRatchetAsOf,
  auditVacuitySeedIntegrity,
  censusOutputSchemas,
  vacuitySeedDigest,
  type CensusableTool,
  type OutputSchemaCensusReport,
  type OutputSchemaPorts,
  type VacuityAllowlistAudit,
  type VacuityExpiryAudit,
  type VacuityRatchetVerdict,
  type VacuitySeedIntegrityAudit,
} from '../output-schema-census.js';

/** The shipped envelope walker and totality predicate, as ports. */
export const OUTPUT_SCHEMA_PORTS: OutputSchemaPorts = Object.freeze({
  extractEnvelopeData: extractEnvelopeDataSchema,
  acceptsEveryValue,
});

/** The vacuity census over the live registry. */
export function censusLiveOutputSchemas(
  tools: readonly CensusableTool[] = TOOL_REGISTRY,
): OutputSchemaCensusReport {
  return censusOutputSchemas(tools, OUTPUT_SCHEMA_PORTS);
}

/** The membership half of the ratchet, over the live census and the live allowlist. */
export function auditLiveVacuityAllowlist(
  report: OutputSchemaCensusReport = censusLiveOutputSchemas(),
  allowlist: readonly string[] = VACUITY_ALLOWLIST_IDS,
): VacuityAllowlistAudit {
  return auditVacuityAllowlist(report, allowlist);
}

/** The seed key-set digest under the pinned algorithm. */
export function liveVacuitySeedDigest(ids: readonly string[]): string {
  return vacuitySeedDigest(ids, VACUITY_SEED_DIGEST_ALGORITHM);
}

/** The pin half of the ratchet, over the live seed. */
export function auditLiveVacuitySeedIntegrity(
  waived: readonly string[] = VACUITY_ALLOWLIST_IDS,
  retired: readonly string[] = VACUITY_RETIRED_IDS,
  pinnedDigest: string = VACUITY_SEED_KEY_SET_DIGEST,
  digestAlgorithm: string = VACUITY_SEED_DIGEST_ALGORITHM,
): VacuitySeedIntegrityAudit {
  return auditVacuitySeedIntegrity(waived, retired, pinnedDigest, digestAlgorithm);
}

/** The expiry half, over the live allowlist and the single pinned horizon. */
export function auditLiveVacuityExpiry(
  today: string,
  entries: Readonly<Record<string, VacuityWaiverEntry>> = VACUITY_ALLOWLIST,
  horizon: string = VACUITY_EXPIRY_HORIZON,
): VacuityExpiryAudit {
  return auditVacuityExpiry(today, entries, horizon);
}

/** The two structural halves, composed. Time is not part of this verdict. */
export function auditLiveVacuityRatchet(
  membership: VacuityAllowlistAudit = auditLiveVacuityAllowlist(),
  seed: VacuitySeedIntegrityAudit = auditLiveVacuitySeedIntegrity(),
): VacuityRatchetVerdict {
  return auditVacuityRatchet(membership, seed);
}

/** The whole ratchet as of a named day. The CI guard computes the same verdict. */
export function auditLiveVacuityRatchetAsOf(
  today: string,
  membership: VacuityAllowlistAudit = auditLiveVacuityAllowlist(),
  seed: VacuitySeedIntegrityAudit = auditLiveVacuitySeedIntegrity(),
  expiry: VacuityExpiryAudit = auditLiveVacuityExpiry(today),
): VacuityRatchetVerdict {
  return auditVacuityRatchetAsOf(today, membership, seed, expiry);
}
