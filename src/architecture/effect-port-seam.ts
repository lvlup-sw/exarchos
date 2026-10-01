/**
 * The narrow effect-port census. Each curated module declares a port, and its live effect
 * footprint must equal that port exactly.
 *
 * The census uses the {@link EffectClass} values and the detectors of `effect-ledger.ts`. The
 * ledger proves that each effect has an owner at layer granularity, but it never bounds one module.
 * This census does. `BROAD_EFFECT_CONTEXT` reports an effect class outside the port.
 * `STALE_EFFECT_PORT` reports a port class that the module does not perform.
 */
import {
  detectModuleEffects,
  scanEffectOccurrences,
  type EffectClass,
  type EffectOccurrence,
  type ModuleLexer,
} from './effect-ledger.js';

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
 * Returns the narrow-port verdict over a collected occurrence set and rule set.
 * `BROAD_EFFECT_CONTEXT` reports a class that a module performs outside its port.
 * `STALE_EFFECT_PORT` reports a port class that the module does not perform, which includes a
 * missing module.
 */
export function runEffectPortCensus(
  occurrences: readonly EffectOccurrence[],
  rules: readonly EffectPortRule[] = NARROW_EFFECT_PORTS,
): EffectPortResult {
  const diagnostics: EffectPortDiagnostic[] = [];

  for (const rule of rules) {
    const actual = footprintOf(rule.module, occurrences);
    const declared = new Set(rule.port);

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
 * Collects the live occurrences and returns the narrow-port verdict over the real tree. The caller
 * supplies `lex` (a {@link ModuleLexer}), because the only sound lexer is the TypeScript compiler,
 * and the effect ledger keeps it out of `src/`.
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
 * Returns the effect footprint of one module source through the ledger detector. Unit tests use it
 * to pin a port against the real source without a tree walk.
 */
export function moduleFootprint(
  module: string,
  source: string,
  lex: ModuleLexer,
): ReadonlySet<EffectClass> {
  return new Set(detectModuleEffects(module, source, lex).map((o) => o.effectClass));
}

const port = (module: string, ports: readonly EffectClass[], note: string): EffectPortRule => ({
  module,
  port: Object.freeze([...ports]),
  note,
});

/**
 * The curated modules with a narrow effect port. Each `port` is the exact live footprint of its
 * module. A wider module trips `BROAD_EFFECT_CONTEXT`, and a narrower or removed one trips
 * `STALE_EFFECT_PORT`.
 */
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
]);

/**
 * The narrow ports for modules under `tools/conformance/src`. The census keys a module by its path
 * relative to the scan root, and these modules have a different root. In
 * {@link NARROW_EFFECT_PORTS}, `STALE_EFFECT_PORT` reports them as missing modules.
 */
export const CONFORMANCE_EFFECT_PORTS: readonly EffectPortRule[] = Object.freeze([
  port(
    'vcs-ownership.ts',
    ['filesystem'],
    'Read-only source-scan gate; reads files only — no process/network port.',
  ),
  port(
    'contract-seam.ts',
    ['filesystem'],
    'Read-only schema source-lint; reads files only — no process/network port.',
  ),
]);
