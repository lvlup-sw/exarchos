/**
 * The effect-provider map for the reachability graph. The `provider/effect owner` hop needs the
 * effect owner behind each mutating public action. Dispatch maps a composite tool to the module
 * that it imports, in `COMPOSITE_HANDLER_LOADERS`. The effect ledger maps a module-path prefix to
 * one owner, in `EFFECT_OWNERSHIP`. Neither names the other.
 *
 * For each composite tool, this map records the handler `area` and the ledger owner of that area.
 * It is not a second ownership authority. {@link validateEffectProviders} checks each entry against
 * the live ledger. A mutating tool with no entry shows as a `missing owner` break at closure time.
 *
 * Dispatch holds the tool-to-area fact only inside loader closures, so this file copies it as a
 * constant. A test checks that each composite tool has exactly one provider. `dispatch-routes.ts`
 * uses the same `area` field to find the composite router of each tool.
 */

import {
  EFFECT_OWNERSHIP,
  type EffectClass,
  type EffectOwnershipRule,
} from '../../architecture/effect-ledger.js';

/** The effect provider of one composite tool: the handler module `area` and its ledger `owner`. */
export interface EffectProvider {
  /** The composite tool, which is the dispatch key, such as `exarchos_workflow`. */
  readonly tool: string;
  /** The module-directory prefix, with forward slashes, of the `COMPOSITE_HANDLER_LOADERS` target. */
  readonly area: string;
  /** The single effect-ledger owner name that backs `area`. */
  readonly owner: string;
  /** The effect class that the owner governs, as in the ledger rule. */
  readonly effectClass: EffectClass;
}

/**
 * The map from composite tool to effect provider, one entry for each tool that can mutate. Each
 * `area` is the directory of the tool import target in `COMPOSITE_HANDLER_LOADERS`.
 * {@link validateEffectProviders} requires exactly one live `EFFECT_OWNERSHIP` rule for each entry.
 */
export const EFFECT_PROVIDERS: readonly EffectProvider[] = Object.freeze([
  { tool: 'exarchos_event', area: 'events/', owner: 'event-store-fs', effectClass: 'filesystem' },
  { tool: 'exarchos_orchestrate', area: 'verbs/', owner: 'orchestrate-fs', effectClass: 'filesystem' },
  { tool: 'exarchos_sync', area: 'sync/', owner: 'sync-fs', effectClass: 'filesystem' },
  { tool: 'exarchos_view', area: 'projections/views/', owner: 'view-fs', effectClass: 'filesystem' },
  { tool: 'exarchos_workflow', area: 'workflow/', owner: 'workflow-fs', effectClass: 'filesystem' },
] as const);

/** One fault from the check of the provider map against the ledger. */
export interface ProviderValidationDiagnostic {
  readonly code: 'UNBACKED_PROVIDER' | 'DUPLICATE_PROVIDER';
  readonly tool: string;
  readonly message: string;
}

/**
 * Whether `rule` backs `provider`. The rule must have the same effect class and owner, and its
 * match prefix must equal the provider area.
 */
export function ruleBacksProvider(rule: EffectOwnershipRule, provider: EffectProvider): boolean {
  return (
    rule.effectClass === provider.effectClass &&
    rule.owner === provider.owner &&
    rule.match === provider.area
  );
}

/**
 * Check the provider map against the live effect ledger. It returns one diagnostic for each fault
 * and does not throw. `ok` is true when each provider has exactly one backing rule and no tool has
 * two providers.
 */
export function validateEffectProviders(
  providers: readonly EffectProvider[] = EFFECT_PROVIDERS,
  rules: readonly EffectOwnershipRule[] = EFFECT_OWNERSHIP,
): { readonly ok: boolean; readonly diagnostics: readonly ProviderValidationDiagnostic[] } {
  const diagnostics: ProviderValidationDiagnostic[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    if (seen.has(provider.tool)) {
      diagnostics.push({
        code: 'DUPLICATE_PROVIDER',
        tool: provider.tool,
        message: `tool '${provider.tool}' has more than one effect provider — exactly one is required`,
      });
    }
    seen.add(provider.tool);

    const backing = rules.filter((rule) => ruleBacksProvider(rule, provider));
    if (backing.length !== 1) {
      diagnostics.push({
        code: 'UNBACKED_PROVIDER',
        tool: provider.tool,
        message:
          `effect provider for tool '${provider.tool}' (owner '${provider.owner}', ` +
          `area '${provider.area}', class '${provider.effectClass}') is backed by ` +
          `${backing.length} live EFFECT_OWNERSHIP rule(s) — exactly one is required. ` +
          `The effect ledger changed under the provider map; reconcile it.`,
      });
    }
  }

  const sorted = [...diagnostics].sort((a, b) =>
    `${a.tool}\u0000${a.code}` < `${b.tool}\u0000${b.code}` ? -1 : 1,
  );
  return { ok: sorted.length === 0, diagnostics: sorted };
}

/** Thrown when the provider map has drifted from the live effect ledger. */
export class ProviderValidationError extends Error {
  override readonly name = 'ProviderValidationError';
  readonly diagnostics: readonly ProviderValidationDiagnostic[];
  constructor(diagnostics: readonly ProviderValidationDiagnostic[]) {
    super(
      `effect-provider map drifted from the ledger — ${diagnostics.length} fault(s):\n` +
        diagnostics.map((d) => `  [${d.code}] ${d.tool}: ${d.message}`).join('\n'),
    );
    this.diagnostics = diagnostics;
  }
}

/**
 * Return the provider map, or throw {@link ProviderValidationError} on drift. The collector calls
 * it, so a stale provider fails and does not show as a false `missing owner` break.
 */
export function assertValidProviders(
  providers: readonly EffectProvider[] = EFFECT_PROVIDERS,
  rules: readonly EffectOwnershipRule[] = EFFECT_OWNERSHIP,
): readonly EffectProvider[] {
  const verdict = validateEffectProviders(providers, rules);
  if (!verdict.ok) throw new ProviderValidationError(verdict.diagnostics);
  return providers;
}
