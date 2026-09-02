// ─── Deterministic canonical JSON for signature payloads (P03-08) ─────────
//
// A signature is only meaningful if the signer and every verifier serialize
// the signed body to *exactly* the same bytes. `JSON.stringify` does not
// guarantee that: object key order follows insertion order, so two logically
// equal manifests can serialize to different bytes and a valid signature would
// spuriously fail (or, worse, a re-ordered forgery could be crafted to collide
// with signer expectations). This module fixes the byte representation by
// sorting object keys recursively and rejecting values that have no canonical
// JSON form (non-finite numbers). Array order is preserved — arrays are ordered
// data and their order is part of what is signed.
//
// This is serialization, not cryptography: the actual signing/verification uses
// `node:crypto` over the bytes this module produces.

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
    // Skip explicit-`undefined` members: they have no JSON form and must not
    // change the signed bytes depending on whether a key is present-undefined
    // versus absent.
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
