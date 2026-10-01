/**
 * Direct adapter-ownership census. An adapter is an effect class that a small,
 * declared set of owner modules performs. An occurrence of the effect class outside
 * the owners is a `DIRECT_ADAPTER_BYPASS`. A declared owner that does not perform
 * the effect is a `STALE_ADAPTER_OWNER`.
 *
 * Only the network adapter is declared. The `filesystem` and `process` classes have
 * many owners in `effect-ledger.ts`. For network, this census is stricter than the
 * ledger: a second network module is a bypass until it is added to the owners.
 */
import {
  scanEffectOccurrences,
  type EffectClass,
  type EffectOccurrence,
  type ModuleLexer,
} from './effect-ledger.js';

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
 * Pure ownership verdict over collected occurrences. Each rule gets two checks:
 *   - `DIRECT_ADAPTER_BYPASS`: an occurrence in a module that is not an owner.
 *   - `STALE_ADAPTER_OWNER`: a declared owner that performs no such effect.
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

/**
 * Scans the live tree and returns the adapter-ownership verdict. The caller injects
 * `lex` because the sound lexer is the TypeScript compiler, and the effect ledger
 * keeps the compiler out of `src/`.
 */
export async function auditAdapterOwnership(
  sourceRoot: string,
  lex: ModuleLexer,
  rules: readonly AdapterOwnershipRule[] = ADAPTER_OWNERSHIP,
): Promise<AdapterOwnershipResult> {
  const occurrences = await scanEffectOccurrences(sourceRoot, lex);
  return runAdapterOwnershipCensus(occurrences, rules);
}

const adapter = (
  name: string,
  effectClass: EffectClass,
  owners: readonly string[],
  note: string,
): AdapterOwnershipRule => ({ adapter: name, effectClass, owners: Object.freeze([...owners]), note });

/**
 * One entry per single-owned effect adapter. The owners are the exact modules that
 * perform the effect on the live tree, so both diagnostics stay live.
 */
export const ADAPTER_OWNERSHIP: readonly AdapterOwnershipRule[] = Object.freeze([
  adapter(
    'network-adapter',
    'network',
    ['workflow/feedback.ts'],
    'All network I/O (http/https/net/tls/dgram/undici/fetch) is owned by the feedback client. ' +
      'A second network caller must be a conscious ADAPTER_OWNERSHIP change, not a silent bypass.',
  ),
]);
