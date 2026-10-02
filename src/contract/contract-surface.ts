/**
 * The canonical serialization of the closed contract surface. It covers the error and exit
 * families, the stable error registry, and the output kinds. It also covers the change and
 * compatibility classes, the migration directions, and the protected request-context fields.
 *
 * `authority-collector.ts` digests it as the `contract-surface` authority. Thus a change to the
 * contract shape trips the authority freeze. The surface holds no free-text descriptions, so a
 * comment edit does not trip the freeze.
 */

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

/** The structural contract surface. {@link canonicalJson} sorts the keys, so the key order has no effect. */
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

/** The canonical serialization that the authority digest reads. */
export function serializeContractSurface(): string {
  return canonicalJson(contractSurface());
}
