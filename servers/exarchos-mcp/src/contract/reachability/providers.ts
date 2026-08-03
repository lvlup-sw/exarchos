// ─── Effect-provider connective map (P05-05) ─────────────────────────────────
//
// PROGRAM-05, the closure capstone (CTR-013). The reachability graph's
// `provider/effect owner` hop needs to know WHICH effect owner backs each public
// action's mutating effect. The two authorities it bridges do not name each
// other:
//
//   • dispatch (`core/dispatch.ts::COMPOSITE_HANDLER_LOADERS`) maps a composite
//     TOOL → the module it dynamically imports (`exarchos_workflow` →
//     `workflow/composite.ts`); and
//   • the effect ledger (`architecture/effect-ledger.ts::EFFECT_OWNERSHIP`) maps
//     a MODULE-PATH PREFIX → a single typed effect owner.
//
// This module is the (small, governed) connective tissue between them: for each
// composite tool it records the module `area` its handler dispatches into (the
// dispatch loader target) and the single effect `owner` that the ledger declares
// for that area. It is NOT a rival ownership authority — every entry is
// VALIDATED against the live `EFFECT_OWNERSHIP` ledger (see
// {@link validateEffectProviders}), so a renamed/removed/moved owner trips the
// validation (a two-way ratchet, exactly like the census pattern it mirrors):
//
//   • a provider whose `(owner, area, effectClass)` no live ownership rule backs
//     is a STALE provider (the ledger changed under it); and
//   • a mutating tool with no provider entry surfaces at closure time as a
//     `missing owner` break (nothing declared the effect owner for its path).
//
// ── The dispatch seam ────────────────────────────────────────────────────────
// The tool→area correspondence is the one fact dispatch encodes only inside its
// loader closures (`() => import('../workflow/composite.js')`), which cannot be
// read as data without importing the module graph. It is transcribed here as a
// governed constant and pinned by a co-located test that asserts every composite
// tool in the live registry has exactly one provider.
// ────────────────────────────────────────────────────────────────────────────

import {
  EFFECT_OWNERSHIP,
  type EffectClass,
  type EffectOwnershipRule,
} from '../../architecture/effect-ledger.js';

/**
 * One composite tool's effect provider: the module `area` its dispatch handler
 * runs in, and the single `owner` the effect ledger declares for that area.
 */
export interface EffectProvider {
  /** The composite tool (dispatch key), e.g. `exarchos_workflow`. */
  readonly tool: string;
  /**
   * The forward-slashed module-directory prefix the tool's composite handler
   * dispatches into — the `COMPOSITE_HANDLER_LOADERS` import target's directory.
   */
  readonly area: string;
  /** The single effect-ledger owner name that backs `area`. */
  readonly owner: string;
  /** The effect primitive the owner governs (matches the ledger rule). */
  readonly effectClass: EffectClass;
}

/**
 * The governed tool → effect-provider map. One entry per composite tool that can
 * perform a mutating effect. Each entry is backed by exactly one live
 * `EFFECT_OWNERSHIP` rule (asserted by {@link validateEffectProviders}).
 *
 * Sourced from `core/dispatch.ts::COMPOSITE_HANDLER_LOADERS`:
 *   exarchos_workflow    → import('../workflow/composite.js')     → workflow/
 *   exarchos_event       → import('../event-store/composite.js')  → event-store/
 *   exarchos_orchestrate → import('../orchestrate/composite.js')  → orchestrate/
 *   exarchos_view        → import('../views/composite.js')        → views/
 *   exarchos_sync        → import('../sync/composite.js')         → sync/
 */
export const EFFECT_PROVIDERS: readonly EffectProvider[] = Object.freeze([
  { tool: 'exarchos_event', area: 'event-store/', owner: 'event-store-fs', effectClass: 'filesystem' },
  { tool: 'exarchos_orchestrate', area: 'orchestrate/', owner: 'orchestrate-fs', effectClass: 'filesystem' },
  { tool: 'exarchos_sync', area: 'sync/', owner: 'sync-fs', effectClass: 'filesystem' },
  { tool: 'exarchos_view', area: 'views/', owner: 'view-fs', effectClass: 'filesystem' },
  { tool: 'exarchos_workflow', area: 'workflow/', owner: 'workflow-fs', effectClass: 'filesystem' },
] as const);

/** A single provider-vs-ledger validation fault. */
export interface ProviderValidationDiagnostic {
  readonly code: 'UNBACKED_PROVIDER' | 'DUPLICATE_PROVIDER';
  readonly tool: string;
  readonly message: string;
}

/**
 * Is `rule` the ledger backing for `provider`? A rule backs a provider when it
 * governs the same effect class, is owned by the same owner, and its match
 * prefix is exactly the provider's area (the layer-granularity rule for that
 * module subtree).
 */
export function ruleBacksProvider(rule: EffectOwnershipRule, provider: EffectProvider): boolean {
  return (
    rule.effectClass === provider.effectClass &&
    rule.owner === provider.owner &&
    rule.match === provider.area
  );
}

/**
 * Validate the governed provider map against the live effect ledger. Pure and
 * total: returns a diagnostic per fault, never throws. `ok === true` means every
 * provider is backed by exactly one real ledger rule and no tool is claimed by
 * two providers — the connective map has not drifted from either authority.
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
 * Validate and return the provider map, or throw {@link ProviderValidationError}
 * on any drift. The collector calls this so a stale provider fails loudly rather
 * than silently dropping an owner and mis-reporting a `missing owner` break.
 */
export function assertValidProviders(
  providers: readonly EffectProvider[] = EFFECT_PROVIDERS,
  rules: readonly EffectOwnershipRule[] = EFFECT_OWNERSHIP,
): readonly EffectProvider[] {
  const verdict = validateEffectProviders(providers, rules);
  if (!verdict.ok) throw new ProviderValidationError(verdict.diagnostics);
  return providers;
}
