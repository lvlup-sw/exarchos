export const typescriptReduction = String.raw`
type ShrinkDomain =
  | { kind: 'boolean' }
  | { kind: 'integer'; min: string; max: string }
  | { kind: 'number'; min: number; max: number }
  | { kind: 'string'; alphabet: string; minLength: number; maxLength: number }
  | { kind: 'enum'; values: string[] }
  | { kind: 'nullable'; value: ShrinkDomain }
  | { kind: 'array'; element: ShrinkDomain; minLength: number; maxLength: number }
  | { kind: 'record'; fields: Record<string, ShrinkDomain> };

function* smallerValues(domain: ShrinkDomain, value: unknown): Generator<unknown> {
  switch (domain.kind) {
    case 'boolean':
      if (value === true) yield false;
      break;
    case 'integer': {
      const current = BigInt(value as string);
      const minimum = BigInt(domain.min);
      const maximum = BigInt(domain.max);
      const target = minimum > 0n ? minimum : maximum < 0n ? maximum : 0n;
      if (current === target) break;
      yield target.toString();
      for (let distance = (current - target) / 2n; distance !== 0n; distance /= 2n) {
        yield (current - distance).toString();
      }
      break;
    }
    case 'number': {
      const current = value as number;
      const target = Math.max(domain.min, Math.min(domain.max, 0));
      if (current === target) break;
      yield target;
      const halfway = current / 2 + target / 2;
      if (halfway !== current && halfway !== target) yield halfway;
      break;
    }
    case 'enum': {
      const index = domain.values.indexOf(value as string);
      yield* domain.values.slice(0, index);
      break;
    }
    case 'nullable':
      if (value !== null) {
        yield null;
        yield* smallerValues(domain.value, value);
      }
      break;
    case 'string': {
      const characters = [...value as string];
      for (const shorter of shorterArrays(characters, domain.minLength)) yield shorter.join('');
      const alphabet = [...domain.alphabet];
      for (let index = 0; index < characters.length; index++) {
        const current = alphabet.indexOf(characters[index]!);
        for (const replacement of alphabet.slice(0, current)) {
          const copy = [...characters];
          copy[index] = replacement;
          yield copy.join('');
        }
      }
      break;
    }
    case 'array': {
      const elements = value as unknown[];
      yield* shorterArrays(elements, domain.minLength);
      for (let index = 0; index < elements.length; index++) {
        for (const replacement of smallerValues(domain.element, elements[index])) {
          const copy = [...elements];
          copy[index] = replacement;
          yield copy;
        }
      }
      break;
    }
    case 'record': {
      const record = value as Record<string, unknown>;
      for (const [key, field] of Object.entries(domain.fields)) {
        for (const replacement of smallerValues(field, record[key])) yield { ...record, [key]: replacement };
      }
      break;
    }
  }
}

function* shorterArrays<T>(values: T[], minimum: number): Generator<T[]> {
  for (let count = values.length - minimum; count > 0; count = Math.floor(count / 2)) {
    for (let start = 0; start + count <= values.length; start++) {
      yield [...values.slice(0, start), ...values.slice(start + count)];
    }
  }
}
`;
