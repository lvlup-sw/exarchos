// ─── Realistic event payloads, DERIVED from the shipped data schemas ─────────
//
// A differential fold whose corpus carries `data: {}` proves almost nothing. A
// reducer arm that reads a field before it mutates cannot fire on an empty bag,
// so "dropping this event changes no state" and "this event's arm never got a
// chance to run" produce the same green. Measured on this tree, an empty-payload
// corpus made 168 of 178 catalog types indistinguishable from a no-op, and the
// eight types the canonical fold mutates on under a real payload — `state.patched`
// and `task.assigned` among them — were among the invisible ones.
//
// So the corpus payload is GENERATED from each type's own `EVENT_DATA_SCHEMAS`
// entry rather than hand-written. Two properties follow, and both matter:
//
//   • a new event type joins the corpus with a realistic payload and nobody
//     edits a table, so the corpus cannot rot into emptiness one type at a time;
//   • the payload cannot disagree with the schema, because it is a reading of
//     the schema.
//
// Every property is filled, optional ones included: the goal is the RICHEST
// admissible payload, since a field left out is a reducer arm left unexercised.
//
// `z.toJSONSchema` is the public projection of a zod schema. Walking
// `_zod.def` directly would couple this helper to zod's internals for no gain —
// JSON Schema already carries every discriminant the sampler needs.

import { z } from 'zod';

/** A JSON-Schema node, as far as the sampler reads one. */
type SchemaNode = Readonly<Record<string, unknown>> | boolean;

const MAX_DEPTH = 6;

function isObjectNode(node: SchemaNode): node is Readonly<Record<string, unknown>> {
  return typeof node === 'object' && node !== null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Resolve a local `$ref` against the document root; unresolvable refs sample as a string. */
function resolveRef(ref: string, root: Readonly<Record<string, unknown>>): SchemaNode | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    const record = asRecord(current);
    if (record === undefined) return undefined;
    current = record[segment];
  }
  const resolved = asRecord(current);
  return resolved;
}

/**
 * A string the node's own constraints admit.
 *
 * The plain `sample-<name>` string satisfies a bare `type: string`, and nothing
 * else: a timestamp field rejects it, a digest field rejects it, a URL field
 * rejects it, and the fold arm behind any of those never runs. Formats come
 * from the JSON Schema `format` keyword; the digest shape comes from its
 * `pattern`; an absolute-path requirement is a refinement the JSON Schema
 * cannot express, so it is read off the property name.
 */
function sampleString(node: Readonly<Record<string, unknown>>, propertyName: string): string {
  const format = node['format'];
  switch (format) {
    case 'date-time':
      return '2026-01-01T00:00:00.000Z';
    case 'date':
      return '2026-01-01';
    case 'time':
      return '00:00:00';
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000';
    case 'uri':
    case 'url':
      return `https://example.test/${propertyName}`;
    case 'email':
      return `${propertyName}@example.test`;
    default:
      break;
  }
  const pattern = node['pattern'];
  if (typeof pattern === 'string') {
    const hexRun = /^\^\[a-f0-9\]\{(\d+)\}\$$/.exec(pattern);
    if (hexRun?.[1] !== undefined) return '0'.repeat(Number(hexRun[1]));
  }
  if (/(^|[a-z])(path|dir|directory|cwd|root)$/i.test(propertyName)) {
    return `/sample/${propertyName}`;
  }
  return `sample-${propertyName}`;
}

/**
 * One deterministic value admitted by `node`.
 *
 * Deterministic on purpose: two runs of the same corpus must fold to the same
 * state, or every differential comparison becomes a coin flip.
 */
function sampleNode(
  node: SchemaNode,
  root: Readonly<Record<string, unknown>>,
  propertyName: string,
  depth: number,
): unknown {
  if (node === true || depth > MAX_DEPTH) return `sample-${propertyName}`;
  if (node === false) return undefined;
  if (!isObjectNode(node)) return `sample-${propertyName}`;

  const ref = node['$ref'];
  if (typeof ref === 'string') {
    const target = resolveRef(ref, root);
    return target === undefined
      ? `sample-${propertyName}`
      : sampleNode(target, root, propertyName, depth + 1);
  }

  if ('const' in node) return node['const'];

  const enumValues = asArray(node['enum']);
  if (enumValues !== undefined && enumValues.length > 0) return enumValues[0];

  for (const branchKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = asArray(node[branchKey]);
    if (branches === undefined || branches.length === 0) continue;
    // The first non-null branch: a nullable field sampled as `null` exercises
    // nothing, and the point of the corpus is to exercise arms.
    for (const branch of branches) {
      const candidate = asRecord(branch);
      if (candidate === undefined) continue;
      if (candidate['type'] === 'null') continue;
      return sampleNode(candidate, root, propertyName, depth + 1);
    }
    const first = asRecord(branches[0]);
    if (first !== undefined) return sampleNode(first, root, propertyName, depth + 1);
  }

  const declaredType = node['type'];
  const type = Array.isArray(declaredType) ? declaredType[0] : declaredType;

  switch (type) {
    case 'string':
      return sampleString(node, propertyName);
    case 'integer':
    case 'number': {
      const minimum = asNumber(node['minimum']);
      const maximum = asNumber(node['maximum']);
      const candidate = minimum ?? 1;
      // A schema-wide `maximum` of `Number.MAX_SAFE_INTEGER` is zod's encoding of
      // "a JS number", not a real bound, so clamping is enough — no scaling.
      return maximum !== undefined && candidate > maximum ? maximum : candidate;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array': {
      // A tuple names each position's schema; sample every position, because
      // a two-element `lineRange` with one entry is not a line range.
      const positions = asArray(node['prefixItems']);
      if (positions !== undefined && positions.length > 0) {
        return positions.map((position, index) => {
          const positionNode = asRecord(position);
          return positionNode === undefined
            ? `sample-${propertyName}-${index + 1}`
            : sampleNode(positionNode, root, `${propertyName}-${index + 1}`, depth + 1);
        });
      }
      const items = node['items'];
      if (items === undefined) return [];
      const itemNode = asRecord(items);
      if (itemNode === undefined) return [];
      // A schema that demands a floor gets the floor: one item under a
      // `minItems: 2` is a payload the schema itself rejects, and a fold arm
      // that only runs on a valid payload would stay inert under it. Each item
      // carries its own ordinal so a uniqueness constraint is honored too.
      const floor = asNumber(node['minItems']) ?? 1;
      const count = Math.max(1, Math.trunc(floor));
      return Array.from({ length: count }, (_, index) =>
        sampleNode(itemNode, root, `${propertyName}-item-${index + 1}`, depth + 1),
      );
    }
    case 'object':
    default:
      break;
  }

  const properties = asRecord(node['properties']);
  if (properties !== undefined) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(properties)) {
      const childNode = asRecord(child);
      if (childNode === undefined) continue;
      const value = sampleNode(childNode, root, key, depth + 1);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  const additional = asRecord(node['additionalProperties']);
  if (additional !== undefined) {
    return { [`${propertyName}Key`]: sampleNode(additional, root, propertyName, depth + 1) };
  }
  if (node['type'] === 'object') return {};

  return `sample-${propertyName}`;
}

/**
 * The richest payload the schema admits, or `undefined` when the type declares
 * no data schema.
 *
 * `undefined` is deliberately distinguishable from `{}`: "this type has no
 * schema to sample" and "this type's schema admits an empty bag" are different
 * facts, and a caller asserting corpus richness has to be able to tell them
 * apart.
 */
export function sampleEventData(
  schema: z.ZodType | undefined,
): Record<string, unknown> | undefined {
  if (schema === undefined) return undefined;
  let jsonSchema: Readonly<Record<string, unknown>>;
  try {
    const produced: unknown = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    const record = asRecord(produced);
    if (record === undefined) return undefined;
    jsonSchema = record;
  } catch {
    // A schema JSON Schema cannot express samples as nothing rather than as an
    // empty bag, so the caller's richness assertion names the type.
    return undefined;
  }
  const sampled = sampleNode(jsonSchema, jsonSchema, 'value', 0);
  const record = asRecord(sampled);
  return record === undefined ? undefined : { ...record };
}
