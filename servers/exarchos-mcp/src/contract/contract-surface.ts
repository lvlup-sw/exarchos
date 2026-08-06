// ─── Canonical contract-surface serialization (P03-02) ───────────────────────
//
// Produces the deterministic, content-addressable serialization of the P03-02
// CLOSED contract surface — the error/exit families, stable error registry,
// output-carrier kinds, compatibility classes, change-class taxonomy, and the
// protected request-context fields. `authority-collector.ts` digests this
// string as the `contract-surface` authority so any change to the actual
// contract shape (a new error code, a changed exit mapping, a new output kind,
// a re-classified change class) trips the P03-01 freeze and demands explicit
// re-approval via the authority lock CLI.
//
// The digest deliberately captures the STRUCTURAL contract — codes, layers,
// exit codes, retry policies, kinds, severities, directions, protected fields,
// and the surface version — but NOT free-text descriptions, so editing a
// doc-comment does not spuriously trip the freeze.
// ────────────────────────────────────────────────────────────────────────────

import {
  FAILURE_LAYERS,
  FAMILY_DEFAULTS,
  CONTRACT_EXIT_CODES,
  STABLE_ERROR_REGISTRY,
  stableErrorCodes,
} from './error-families.js';
import { OUTPUT_KINDS, describeOutputKind } from './envelope.js';
import {
  CONTRACT_SURFACE_VERSION,
  CONTRACT_CHANGE_CLASSES,
  changeClassSeverity,
} from './compatibility.js';
import { PROTECTED_CONTEXT_FIELDS, canonicalJson } from './request-context.js';

const sorted = <T>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));

/**
 * The structural contract-surface object. Key order is irrelevant —
 * {@link canonicalJson} sorts recursively — so this is a stable value.
 */
export function contractSurface(): Record<string, unknown> {
  return {
    version: CONTRACT_SURFACE_VERSION,
    exitCodes: { ...CONTRACT_EXIT_CODES },
    failureLayers: sorted(FAILURE_LAYERS),
    families: Object.fromEntries(
      sorted(FAILURE_LAYERS).map((layer) => {
        const f = FAMILY_DEFAULTS[layer];
        return [layer, { code: f.code, exitCode: f.exitCode, retry: f.retry }];
      }),
    ),
    errorCodes: Object.fromEntries(
      stableErrorCodes().map((code) => {
        const spec = STABLE_ERROR_REGISTRY[code];
        return [code, { layer: spec.layer, exitCode: spec.exitCode, retry: spec.retry }];
      }),
    ),
    outputKinds: Object.fromEntries(
      sorted(OUTPUT_KINDS).map((kind) => {
        const d = describeOutputKind(kind);
        return [kind, { success: d.success, economyMarker: d.economyMarker }];
      }),
    ),
    changeClasses: Object.fromEntries(
      sorted(CONTRACT_CHANGE_CLASSES).map((cls) => [cls, changeClassSeverity(cls)]),
    ),
    compatibilityClasses: sorted(['additive', 'behavioral', 'breaking', 'compatible']),
    migrationDirections: sorted(['backward', 'forward']),
    protectedContextFields: sorted(PROTECTED_CONTEXT_FIELDS),
  };
}

/** The canonical, deterministic serialization digested as the authority. */
export function serializeContractSurface(): string {
  return canonicalJson(contractSurface());
}
