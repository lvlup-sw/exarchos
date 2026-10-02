// Realistic event payloads, derived from the shipped data schemas.
//
// A differential fold over `data: {}` proves almost nothing. A reducer arm that reads a field
// before it mutates cannot fire on an empty bag. A dropped event and an arm that never ran then
// give the same green result.
//
// The sampler thus generates each payload from the `EVENT_DATA_SCHEMAS` entry of its type. A new
// event type joins the corpus with no table edit, and the payload always agrees with the schema.
// It fills every property, optional ones included, because a missing field leaves an arm unused.
//
// The sampler walks the output of `z.toJSONSchema`, the public projection of a zod schema, not
// the zod internals.

import { z } from 'zod';

/** A JSON-Schema node, as far as the sampler reads one. */
type SchemaNode = Readonly<Record<string, unknown>> | boolean;

/**
 * A recursion guard against runaway or cyclic schemas, not a limit on real nesting. The artifact
 * reference of an evidence row nests seven levels deep.
 */
const MAX_DEPTH = 10;

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

/** Resolves a local `$ref` against the document root, or returns `undefined`. */
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
 * A string that the constraints of the node admit. The JSON Schema `format` keyword gives the
 * format, and a hex `pattern` gives the digest shape. JSON Schema cannot express an absolute-path
 * refinement, so the property name decides it.
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
 * One deterministic value that `node` admits, so two runs of a corpus fold to the same state.
 *
 * A union samples its first non-null branch, because a `null` exercises no arm. A number takes
 * its `minimum` or 1, clamped to `maximum`. A tuple samples every position. An array gets
 * `minItems` items, at least one, and each item carries its own ordinal for a uniqueness rule.
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
      return maximum !== undefined && candidate > maximum ? maximum : candidate;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array': {
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
 * The richest payload that the schema admits. It returns `undefined`, not `{}`, when the type has
 * no data schema or `z.toJSONSchema` cannot express the schema. A caller that asserts corpus
 * richness can thus tell "no schema" from "the schema admits an empty bag".
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
    return undefined;
  }
  const sampled = sampleNode(jsonSchema, jsonSchema, 'value', 0);
  const record = asRecord(sampled);
  return record === undefined ? undefined : { ...record };
}
