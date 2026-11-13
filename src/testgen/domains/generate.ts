import { canonicalJson, inDomain } from './schema.js';
import type { Domain, JsonValue } from './schema.js';

export interface GenerationBudget {
  seed: number;
  count: number;
  maxAttempts: number;
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function chooseInteger(min: bigint, max: bigint, random: () => number): bigint {
  const width = max - min + 1n;
  const bits = width.toString(2).length;
  let value = 0n;
  for (let offset = 0; offset < bits; offset += 32) {
    value = (value << 32n) | BigInt(Math.floor(random() * 4294967296));
  }
  return min + value % width;
}

export function sample(domain: Domain, random: () => number): JsonValue {
  switch (domain.kind) {
    case 'boolean': return random() < 0.5;
    case 'integer': return chooseInteger(BigInt(domain.min), BigInt(domain.max), random).toString();
    case 'number': {
      const fraction = random();
      const value = domain.min * (1 - fraction) + domain.max * fraction;
      return Math.max(domain.min, Math.min(domain.max, value)) || 0;
    }
    case 'enum': return domain.values[Math.floor(random() * domain.values.length)]!;
    case 'string': {
      const alphabet = [...domain.alphabet];
      const size = Number(chooseInteger(BigInt(domain.minLength), BigInt(domain.maxLength), random));
      return Array.from({ length: size }, () => alphabet[Math.floor(random() * alphabet.length)]!).join('');
    }
    case 'nullable': return random() < 0.25 ? null : sample(domain.value, random);
    case 'array': {
      const size = Number(chooseInteger(BigInt(domain.minLength), BigInt(domain.maxLength), random));
      return Array.from({ length: size }, () => sample(domain.element, random));
    }
    case 'record': return Object.fromEntries(Object.entries(domain.fields).map(([key, field]) => [key, sample(field, random)]));
  }
}

export function simplest(domain: Domain): JsonValue {
  switch (domain.kind) {
    case 'boolean': return false;
    case 'integer': return (BigInt(domain.min) > 0n ? BigInt(domain.min) : BigInt(domain.max) < 0n ? BigInt(domain.max) : 0n).toString();
    case 'number': return Math.max(domain.min, Math.min(domain.max, 0)) || 0;
    case 'string': return [...domain.alphabet][0]!.repeat(domain.minLength);
    case 'enum': return domain.values[0]!;
    case 'nullable': return null;
    case 'array': return Array.from({ length: domain.minLength }, () => simplest(domain.element));
    case 'record': return Object.fromEntries(Object.entries(domain.fields).map(([key, field]) => [key, simplest(field)]));
  }
}

export function* boundaries(domain: Domain): Generator<JsonValue> {
  yield simplest(domain);
  switch (domain.kind) {
    case 'boolean': yield true; break;
    case 'integer':
      for (const value of [BigInt(domain.min), BigInt(domain.min) + 1n, BigInt(domain.max) - 1n, BigInt(domain.max)]) {
        if (value >= BigInt(domain.min) && value <= BigInt(domain.max)) yield value.toString();
      }
      break;
    case 'number': yield domain.min; yield domain.max; break;
    case 'enum': yield* domain.values; break;
    case 'string':
      for (const character of domain.alphabet) yield character.repeat(domain.maxLength);
      break;
    case 'nullable': yield* boundaries(domain.value); break;
    case 'array':
      yield Array.from({ length: domain.maxLength }, () => simplest(domain.element));
      if (domain.maxLength > 0) {
        for (const value of boundaries(domain.element)) {
          yield Array.from({ length: Math.max(1, domain.minLength) }, () => value);
        }
      }
      break;
    case 'record':
      for (const [key, field] of Object.entries(domain.fields)) {
        for (const value of boundaries(field)) yield { ...simplest(domain) as Record<string, JsonValue>, [key]: value };
      }
      break;
  }
}

export function generateCases(domain: Domain, explicit: JsonValue[], budget: GenerationBudget) {
  const cases = [...explicit];
  const seen = new Set(cases.map(canonicalJson));
  const random = seededRandom(budget.seed);
  let attempts = 0;
  let duplicates = 0;
  const edges = boundaries(domain);
  let boundariesFinished = false;
  while (cases.length < budget.count && attempts < budget.maxAttempts) {
    const edge: IteratorResult<JsonValue> | undefined = boundariesFinished ? undefined : edges.next();
    boundariesFinished = edge?.done ?? boundariesFinished;
    const candidate = edge && !edge.done ? edge.value : sample(domain, random);
    attempts++;
    if (!inDomain(domain, candidate)) throw new Error('Generated candidate violates its declared domain.');
    const key = canonicalJson(candidate);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    cases.push(candidate);
  }
  return { cases, attempts, duplicates, exhausted: cases.length < budget.count };
}
