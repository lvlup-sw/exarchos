import { z } from 'zod';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Domain =
  | { kind: 'boolean' }
  | { kind: 'integer'; min: string; max: string }
  | { kind: 'number'; min: number; max: number }
  | { kind: 'string'; alphabet: string; minLength: number; maxLength: number }
  | { kind: 'enum'; values: string[] }
  | { kind: 'nullable'; value: Domain }
  | { kind: 'array'; element: Domain; minLength: number; maxLength: number }
  | { kind: 'record'; fields: Record<string, Domain> };

export const decimalInteger = z.string().max(128).regex(/^(?:0|-?[1-9][0-9]*)(?![\s\S])/);
const length = z.number().int().min(0).max(64);
export const domainSchema: z.ZodType<Domain> = z.lazy(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('boolean') }),
  z.strictObject({ kind: z.literal('integer'), min: decimalInteger, max: decimalInteger }),
  z.strictObject({ kind: z.literal('number'), min: z.number(), max: z.number() }),
  z.strictObject({ kind: z.literal('string'), alphabet: z.string().min(1).max(256), minLength: length, maxLength: length }),
  z.strictObject({ kind: z.literal('enum'), values: z.array(z.string().max(256)).min(1).max(64) }),
  z.strictObject({ kind: z.literal('nullable'), value: domainSchema }),
  z.strictObject({ kind: z.literal('array'), element: domainSchema, minLength: length, maxLength: length }),
  z.strictObject({ kind: z.literal('record'), fields: z.record(z.string().min(1).max(100), domainSchema) }),
]));
export const jsonValueSchema: z.ZodType<JsonValue> = z.json();

export function domainProblem(domain: Domain, depth = 0): string | undefined {
  if (valueSize(domain) > 4096) return 'A domain value exceeds the 4096-node budget.';
  if (depth > 6) return 'Domain nesting exceeds six levels.';
  switch (domain.kind) {
    case 'integer':
      return BigInt(domain.min) > BigInt(domain.max) ? 'Integer bounds are reversed.' : undefined;
    case 'number':
      return domain.min > domain.max ? 'Number bounds are reversed.' : undefined;
    case 'string':
      if (domain.minLength > domain.maxLength) return 'String length bounds are reversed.';
      if (/\p{Surrogate}/u.test(domain.alphabet)) return 'String alphabets require Unicode scalar values.';
      if (new Set(domain.alphabet).size !== [...domain.alphabet].length) return 'Alphabet characters must be unique.';
      return undefined;
    case 'enum':
      return new Set(domain.values).size !== domain.values.length ? 'Enum values must be unique.' : undefined;
    case 'nullable':
      return domainProblem(domain.value, depth + 1);
    case 'array':
      if (domain.minLength > domain.maxLength) return 'Array length bounds are reversed.';
      return domainProblem(domain.element, depth + 1);
    case 'record': {
      const fields = Object.values(domain.fields);
      if (fields.length > 32) return 'Records support at most 32 fields.';
      return fields.map((field) => domainProblem(field, depth + 1)).find(Boolean);
    }
    case 'boolean':
      return undefined;
  }
}

export function inDomain(domain: Domain, value: unknown): value is JsonValue {
  switch (domain.kind) {
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return typeof value === 'string' && decimalInteger.safeParse(value).success
      && BigInt(value) >= BigInt(domain.min) && BigInt(value) <= BigInt(domain.max);
    case 'number': return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
      && value >= domain.min && value <= domain.max;
    case 'string': return typeof value === 'string' && [...value].length >= domain.minLength
      && [...value].length <= domain.maxLength && [...value].every((character) => [...domain.alphabet].includes(character));
    case 'enum': return typeof value === 'string' && domain.values.includes(value);
    case 'nullable': return value === null || inDomain(domain.value, value);
    case 'array': return Array.isArray(value) && value.length >= domain.minLength && value.length <= domain.maxLength
      && Array.from(value).every((element) => inDomain(domain.element, element));
    case 'record': return value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === Object.keys(domain.fields).length
      && Object.entries(domain.fields).every(([key, field]) => Object.hasOwn(value, key)
        && inDomain(field, (value as Record<string, unknown>)[key]));
  }
}

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function valueSize(domain: Domain): number {
  switch (domain.kind) {
    case 'array': return 1 + domain.maxLength * valueSize(domain.element);
    case 'record': return 1 + Object.values(domain.fields).reduce((sum, field) => sum + valueSize(field), 0);
    case 'nullable': return valueSize(domain.value);
    default: return 1;
  }
}

export function maximumEncodedSize(domain: Domain): number {
  switch (domain.kind) {
    case 'boolean': return 5;
    case 'integer': return Math.max(domain.min.length, domain.max.length) + 2;
    case 'number': return 25;
    case 'string': return 2 + domain.maxLength * 12;
    case 'enum': return Math.max(...domain.values.map((value) => JSON.stringify(value).length));
    case 'nullable': return Math.max(4, maximumEncodedSize(domain.value));
    case 'array': return 2 + domain.maxLength * (1 + maximumEncodedSize(domain.element));
    case 'record': return 2 + Object.entries(domain.fields).reduce((sum, [key, value]) => sum + JSON.stringify(key).length + 2 + maximumEncodedSize(value), 0);
  }
}
