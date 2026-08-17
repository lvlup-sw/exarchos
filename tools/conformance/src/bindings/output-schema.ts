// RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28) — the composition root for DR-4's
// outputSchema vacuity census. No production importer by design: it binds an instrument that
// governs the tool registry rather than participating in it, and its consumers are that census's
// suite plus the `output-schema-ratchet-guard` CI entrypoint. Deleted when the census is.
//
/**
 * Bindings for the `outputSchema` vacuity census (DR-4).
 *
 * Five subjects, which is why this census was the heaviest to invert: the tool
 * registry, the envelope walker, the totality predicate, the vacuity allowlist
 * and its frozen pin.
 *
 * The plan expected the two `output-schema-*` data files to migrate WITH the
 * conformance package. They cannot: `registry.ts` and `output-schema-declaration.ts`
 * both import `VacuityWaiverId` from the allowlist, so it is pinned to `src/` by
 * production types. Parameterising the census and binding the data here is the
 * shape the tree actually permits.
 *
 * `registry.ts` is a DR-1 declaration STORE, so this module must not import a
 * contract module (`contract/declaration.ts`, `contract/declaration-seam.ts`).
 * See `./README.md`.
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

/** DR-4's ratchet whole, as of a named day. This is what the CI guard runs. */
export function auditLiveVacuityRatchetAsOf(
  today: string,
  membership: VacuityAllowlistAudit = auditLiveVacuityAllowlist(),
  seed: VacuitySeedIntegrityAudit = auditLiveVacuitySeedIntegrity(),
  expiry: VacuityExpiryAudit = auditLiveVacuityExpiry(today),
): VacuityRatchetVerdict {
  return auditVacuityRatchetAsOf(today, membership, seed, expiry);
}
