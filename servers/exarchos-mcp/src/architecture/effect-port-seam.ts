import {
  detectModuleEffects,
  scanEffectOccurrences,
  type EffectClass,
  type EffectOccurrence,
  type ModuleLexer,
} from './effect-ledger.js';

/**
 * P07-06 — narrow effect-port census (structural conformance).
 *
 * The structural-closure plan (BASE-003, WFQ-016) requires modules to receive a
 * **narrow effect port**, not a broad ambient effect context, and for mechanical
 * checks to **reject a broad effect context**. This module is that check. It
 * builds directly on the P04-01 effect ledger's vocabulary — the same three
 * statically-detectable {@link EffectClass} primitives (`filesystem`, `process`,
 * `network`), detected by the ledger's own {@link detectModuleEffects} /
 * {@link scanEffectOccurrences} (consumed read-only) — and adds a FINER,
 * per-module guarantee the layer-granular ledger deliberately does not express.
 *
 * ── Ledger vs. port (why this is additive, not redundant) ───────────────────
 * `effect-ledger.ts` proves *completeness*: every effect occurrence has SOME
 * declared owner, at LAYER granularity (e.g. all of `verbs/` may perform
 * `process` AND `filesystem`). It never bounds a *single* module. The effect-port
 * census proves *narrowness*: a curated module's declared port is its EXACT
 * effect footprint, so a module the ledger would happily let widen (because its
 * layer owns the extra class) is still rejected here. Concretely: the ledger
 * grants `utils/process.ts` both `process` (its exact rule) and `filesystem` (the
 * `utils/` prefix rule); this census pins its port to exactly
 * `[filesystem, process]` and REJECTS it the day it also opens a network socket.
 *
 * ── "Broad" defined concretely ──────────────────────────────────────────────
 * A module's effect context is BROAD when its live footprint contains an effect
 * class its declared port does NOT list — i.e. it exposes/uses more effect
 * classes than the narrow port grants. That is the {@link EffectPortDiagnostic}
 * `BROAD_EFFECT_CONTEXT`. Like every census on this ladder it is a **two-way
 * ratchet**: a port that OVER-declares (lists a class the module no longer
 * performs, or names a module that performs nothing / is gone) is stale cover and
 * trips `STALE_EFFECT_PORT`, so a narrow-port claim can never rot into a rubber
 * stamp. On the live tree each port equals its module's exact footprint, so
 * neither tooth bites — until someone widens (or empties) a narrow module.
 */

/** A declared narrow port: `module`'s effect footprint must equal `port` exactly. */
export interface EffectPortRule {
  /** Repo-relative to the scan root, forward-slashed. */
  readonly module: string;
  /** The exact effect classes this module is permitted to perform. */
  readonly port: readonly EffectClass[];
  /** Why this module is held to a narrow effect port. */
  readonly note: string;
}

export type EffectPortDiagnostic =
  | {
      readonly code: 'BROAD_EFFECT_CONTEXT';
      readonly module: string;
      readonly effectClass: EffectClass;
      readonly port: readonly EffectClass[];
      readonly message: string;
    }
  | {
      readonly code: 'STALE_EFFECT_PORT';
      readonly module: string;
      readonly effectClass: EffectClass;
      readonly message: string;
    };

export interface EffectPortResult {
  readonly ok: boolean;
  readonly ruleCount: number;
  readonly diagnostics: readonly EffectPortDiagnostic[];
}

/** The set of effect classes a module actually performs, from its occurrences. */
export function footprintOf(
  module: string,
  occurrences: readonly EffectOccurrence[],
): ReadonlySet<EffectClass> {
  const set = new Set<EffectClass>();
  for (const occ of occurrences) {
    if (occ.module === module) set.add(occ.effectClass);
  }
  return set;
}

/**
 * Pure narrow-port verdict over an already-collected occurrence set and rule set.
 *
 * Two independent, complementary checks, each with its own diagnostic:
 *   - BROAD_EFFECT_CONTEXT — a module performs an effect class outside its port;
 *   - STALE_EFFECT_PORT    — a port declares a class the module does not perform
 *                            (over-declaration / phantom module — stale cover).
 */
export function runEffectPortCensus(
  occurrences: readonly EffectOccurrence[],
  rules: readonly EffectPortRule[] = NARROW_EFFECT_PORTS,
): EffectPortResult {
  const diagnostics: EffectPortDiagnostic[] = [];

  for (const rule of rules) {
    const actual = footprintOf(rule.module, occurrences);
    const declared = new Set(rule.port);

    // BROAD: the module does something the narrow port does not grant.
    for (const effectClass of [...actual].sort()) {
      if (!declared.has(effectClass)) {
        diagnostics.push({
          code: 'BROAD_EFFECT_CONTEXT',
          module: rule.module,
          effectClass,
          port: rule.port,
          message:
            `Module "${rule.module}" performs a ${effectClass} effect that its narrow ` +
            `port [${[...rule.port].sort().join(', ') || '<none>'}] does not grant — a ` +
            `broad effect context. Route the ${effectClass} effect through a dedicated ` +
            `owner or widen NARROW_EFFECT_PORTS for "${rule.module}" if it is intended.`,
        });
      }
    }

    // STALE: the port names a class the module no longer performs (or the module
    // performs nothing at all / is gone) — phantom cover.
    for (const effectClass of [...declared].sort()) {
      if (!actual.has(effectClass)) {
        diagnostics.push({
          code: 'STALE_EFFECT_PORT',
          module: rule.module,
          effectClass,
          message:
            `Narrow port for "${rule.module}" declares a ${effectClass} effect the module ` +
            `does not perform — stale cover. Remove it from the port or restore the effect.`,
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
 * Collect the live occurrences and return the narrow-port verdict over the real
 * tree.
 *
 * `lex` is the ledger's lexer port — required here for the same reason it is
 * required there (see `effect-ledger.ts`'s {@link ModuleLexer}): this module is
 * shipped source, and the only sound lexer is the TypeScript compiler, which the
 * effect ledger will not admit into `src/`.
 */
export async function auditEffectPorts(
  sourceRoot: string,
  lex: ModuleLexer,
  rules: readonly EffectPortRule[] = NARROW_EFFECT_PORTS,
): Promise<EffectPortResult> {
  const occurrences = await scanEffectOccurrences(sourceRoot, lex);
  return runEffectPortCensus(occurrences, rules);
}

/**
 * Convenience: the exact effect footprint of a single module's source, via the
 * ledger's own detector. Used by unit tests to pin a module's port against its
 * real source without walking the tree.
 */
export function moduleFootprint(
  module: string,
  source: string,
  lex: ModuleLexer,
): ReadonlySet<EffectClass> {
  return new Set(detectModuleEffects(module, source, lex).map((o) => o.effectClass));
}

// ─── The declared narrow ports ──────────────────────────────────────────────
//
// One entry per curated module whose effect port is intentionally narrow. Each
// `port` is the module's EXACT live footprint (verified against the ledger's
// scanner), so both ratchet teeth are live: widening a module trips
// BROAD_EFFECT_CONTEXT and shrinking/removing one trips STALE_EFFECT_PORT.

const port = (module: string, ports: readonly EffectClass[], note: string): EffectPortRule => ({
  module,
  port: Object.freeze([...ports]),
  note,
});

export const NARROW_EFFECT_PORTS: readonly EffectPortRule[] = Object.freeze([
  port(
    'workflow/feedback.ts',
    ['network'],
    'The single network effect owner — a pure network client; must never grow a filesystem or process port.',
  ),
  port(
    'utils/process.ts',
    ['filesystem', 'process'],
    'The cross-OS spawn primitive (+ existsSync probe); must never become a network client.',
  ),
  port(
    'architecture/effect-ledger.ts',
    ['filesystem'],
    'Read-only source-scan gate; reads files only — no process/network port.',
  ),
  port(
    'architecture/vcs-ownership.ts',
    ['filesystem'],
    'Read-only source-scan gate; reads files only — no process/network port.',
  ),
  port(
    'architecture/contract-seam.ts',
    ['filesystem'],
    'Read-only schema source-lint; reads files only — no process/network port.',
  ),
]);
