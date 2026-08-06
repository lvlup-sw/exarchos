import { scanEffectOccurrences, type EffectClass, type EffectOccurrence } from './effect-ledger.js';

/**
 * P07-06 — direct adapter-ownership census (structural conformance).
 *
 * The structural-closure plan (BASE-003, WFQ-016) requires mechanical checks to
 * **reject direct adapter ownership** — an adapter's effect performed outside the
 * single module declared to own it. `architecture/vcs-ownership.ts` (P04-05)
 * proves this for the *git/worktree adapter*: worktree/branch MUTATION must route
 * through the declared owner surface, and a direct bypass fails closed. This
 * module GENERALIZES that two-way-ratchet shape beyond VCS to *effect-class
 * adapters*, reusing the P04-01 ledger's occurrence scanner ({@link
 * scanEffectOccurrences}, consumed read-only) as the detection instrument.
 *
 * An ADAPTER here is a named effect surface (an {@link EffectClass}) that is meant
 * to be owned by a small, explicit set of modules — the adapter's owner surface.
 * Any occurrence of that effect class OUTSIDE the owner surface is a
 * `DIRECT_ADAPTER_BYPASS` (the analogue of P04-05's `DIRECT_VCS_BYPASS`), and any
 * declared owner that no longer performs the effect is a `STALE_ADAPTER_OWNER`
 * (the analogue of `STALE_VCS_OWNER`) — the same no-mask ratchet, so the owner
 * allowlist can never rot into a rubber stamp.
 *
 * ── Scope: which adapters are single-owned ──────────────────────────────────
 * Only the **network** adapter is declared here, because it is the one effect
 * class the live tree confines to a SINGLE module (`workflow/feedback.ts`, the
 * feedback client — verified via the ledger scan). `filesystem` and `process` are
 * pervasive and owned at LAYER granularity by `effect-ledger.ts`, not by a single
 * module, so confining them would demand an owner list so large it would rubber-
 * stamp rather than constrain — a deliberate, documented scoping choice mirroring
 * the one `vcs-ownership.ts` makes for ambiguous git tokens. The registry itself
 * is general: adding a newly-single-owned adapter is a one-line
 * {@link ADAPTER_OWNERSHIP} entry.
 *
 * Note this is INTENTIONALLY stricter than the effect ledger for network: the
 * ledger would let a second network owner in via a new ownership rule; here a
 * second owner is a BYPASS until it is consciously added to the owner surface —
 * exactly the anti-proliferation guarantee `vcs-ownership.ts` adds on top of the
 * ledger's `process` layer rules.
 */

/** A declared adapter: effect class `effectClass` is owned only by `owners`. */
export interface AdapterOwnershipRule {
  /** A human name for the adapter surface (for diagnostics). */
  readonly adapter: string;
  /** The effect class this adapter comprises. */
  readonly effectClass: EffectClass;
  /** The modules permitted to perform the effect directly. */
  readonly owners: readonly string[];
  /** Why this adapter is confined to its owner surface. */
  readonly note: string;
}

export type AdapterOwnershipDiagnostic =
  | {
      readonly code: 'DIRECT_ADAPTER_BYPASS';
      readonly adapter: string;
      readonly effectClass: EffectClass;
      readonly module: string;
      readonly evidence: string;
      readonly message: string;
    }
  | {
      readonly code: 'STALE_ADAPTER_OWNER';
      readonly adapter: string;
      readonly effectClass: EffectClass;
      readonly module: string;
      readonly message: string;
    };

export interface AdapterOwnershipResult {
  readonly ok: boolean;
  readonly ruleCount: number;
  readonly diagnostics: readonly AdapterOwnershipDiagnostic[];
}

/**
 * Pure ownership verdict over an already-collected occurrence set and rule set.
 *
 * Two independent, complementary checks per adapter, each with its own diagnostic:
 *   - DIRECT_ADAPTER_BYPASS — an effect occurrence in a module no owner claims;
 *   - STALE_ADAPTER_OWNER   — a declared owner that performs no such effect.
 */
export function runAdapterOwnershipCensus(
  occurrences: readonly EffectOccurrence[],
  rules: readonly AdapterOwnershipRule[] = ADAPTER_OWNERSHIP,
): AdapterOwnershipResult {
  const diagnostics: AdapterOwnershipDiagnostic[] = [];

  for (const rule of rules) {
    const owners = new Set(rule.owners);
    const classOccurrences = occurrences.filter((o) => o.effectClass === rule.effectClass);

    for (const occ of classOccurrences) {
      if (!owners.has(occ.module)) {
        diagnostics.push({
          code: 'DIRECT_ADAPTER_BYPASS',
          adapter: rule.adapter,
          effectClass: rule.effectClass,
          module: occ.module,
          evidence: occ.evidence,
          message:
            `Module "${occ.module}" performs a direct ${rule.adapter} (${rule.effectClass}) ` +
            `effect (via "${occ.evidence}") outside its owner surface ` +
            `[${[...rule.owners].sort().join(', ') || '<none>'}]. Route the ${rule.adapter} ` +
            `effect through the declared owner or add the module to ADAPTER_OWNERSHIP.`,
        });
      }
    }

    for (const owner of rule.owners) {
      const claims = classOccurrences.some((o) => o.module === owner);
      if (!claims) {
        diagnostics.push({
          code: 'STALE_ADAPTER_OWNER',
          adapter: rule.adapter,
          effectClass: rule.effectClass,
          module: owner,
          message:
            `${rule.adapter} owner "${owner}" performs no ${rule.effectClass} effect — stale ` +
            `cover. Remove it from the ${rule.adapter} owner surface or restore the effect.`,
        });
      }
    }
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    ruleCount: rules.length,
    diagnostics,
  });
}

/** Collect the live occurrences and return the adapter-ownership verdict over the real tree. */
export async function auditAdapterOwnership(
  sourceRoot: string,
  rules: readonly AdapterOwnershipRule[] = ADAPTER_OWNERSHIP,
): Promise<AdapterOwnershipResult> {
  const occurrences = await scanEffectOccurrences(sourceRoot);
  return runAdapterOwnershipCensus(occurrences, rules);
}

// ─── The declared adapter ownership ─────────────────────────────────────────
//
// One entry per single-owned effect adapter. The owner surface is the EXACT set
// of modules that perform the effect on the live tree, so both ratchet teeth are
// live: a new occurrence elsewhere trips DIRECT_ADAPTER_BYPASS and losing the
// effect in a declared owner trips STALE_ADAPTER_OWNER.

const adapter = (
  name: string,
  effectClass: EffectClass,
  owners: readonly string[],
  note: string,
): AdapterOwnershipRule => ({ adapter: name, effectClass, owners: Object.freeze([...owners]), note });

export const ADAPTER_OWNERSHIP: readonly AdapterOwnershipRule[] = Object.freeze([
  adapter(
    'network-adapter',
    'network',
    ['workflow/feedback.ts'],
    'All network I/O (http/https/net/tls/dgram/undici/fetch) is owned by the feedback client. ' +
      'A second network caller must be a conscious ADAPTER_OWNERSHIP change, not a silent bypass.',
  ),
]);
