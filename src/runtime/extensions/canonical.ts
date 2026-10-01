/**
 * Deterministic canonical JSON for signature payloads. The signer and each
 * verifier must serialize the signed body to the same bytes. `JSON.stringify`
 * keeps insertion order, so two equal manifests can give different bytes.
 * This module sorts object keys recursively, keeps array order, and rejects
 * non-finite numbers. It does no cryptography: `node:crypto` signs and verifies
 * the bytes.
 */

/** JSON value the canonicalizer accepts. Deliberately excludes `undefined`. */
export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/** Raised when a value cannot be represented as canonical JSON. */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Serialize `value` with sorted object keys. A member with the value
 * `undefined` is skipped, so a present-undefined key and an absent key give the
 * same bytes.
 */
function serialize(value: CanonicalJsonValue): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(
          `non-finite number cannot be canonicalized: ${String(value)}`,
        );
      }
      return JSON.stringify(value);
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }

  const object = value as { readonly [key: string]: CanonicalJsonValue };
  const parts: string[] = [];
  for (const key of Object.keys(object).sort()) {
    const child = object[key];
    if (child === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${serialize(child)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Serialize `value` to canonical (key-sorted) JSON text. */
export function canonicalJson(value: CanonicalJsonValue): string {
  return serialize(value);
}

/** Serialize `value` to canonical JSON bytes (UTF-8) for signing/verification. */
export function canonicalBytes(value: CanonicalJsonValue): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}
