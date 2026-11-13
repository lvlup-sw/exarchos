import type { Domain } from '../../domains/schema.js';
import { csharpLiteral } from './csharp-literal.js';

export function typescriptDomainCheck(domain: Domain, value = 'value', depth = 0): string {
  const text = `(${value} as string)`;
  switch (domain.kind) {
    case 'boolean': return `typeof ${value} === 'boolean'`;
    case 'integer': return `(typeof ${value} === 'string' && ${text}.length <= 128 && /^(?:0|-?[1-9][0-9]*)(?![\\s\\S])/.test(${text}) && BigInt(${text}) >= BigInt(${JSON.stringify(domain.min)}) && BigInt(${text}) <= BigInt(${JSON.stringify(domain.max)}))`;
    case 'number': return `(typeof ${value} === 'number' && Number.isFinite(${value}) && !Object.is(${value}, -0) && (${value} as number) >= ${domain.min} && (${value} as number) <= ${domain.max})`;
    case 'string': return `(typeof ${value} === 'string' && [...${text}].length >= ${domain.minLength} && [...${text}].length <= ${domain.maxLength} && [...${text}].every(character => [...${JSON.stringify(domain.alphabet)}].includes(character)))`;
    case 'enum': return `(typeof ${value} === 'string' && ${JSON.stringify(domain.values)}.includes(${text}))`;
    case 'nullable': return `(${value} === null || ${typescriptDomainCheck(domain.value, value, depth + 1)})`;
    case 'array': {
      const item = `item${depth}`;
      const array = `(${value} as unknown[])`;
      return `(Array.isArray(${value}) && ${array}.length >= ${domain.minLength} && ${array}.length <= ${domain.maxLength} && Array.from(${array}).every((${item}: unknown) => ${typescriptDomainCheck(domain.element, item, depth + 1)}))`;
    }
    case 'record': {
      const fields = Object.entries(domain.fields).map(([key, field]) => {
        const name = JSON.stringify(key);
        return `Object.hasOwn(${value} as object, ${name}) && ${typescriptDomainCheck(field, `(${value} as Record<string, unknown>)[${name}]`, depth + 1)}`;
      });
      return `(${value} !== null && typeof ${value} === 'object' && !Array.isArray(${value}) && Object.keys(${value} as object).length === ${fields.length}${fields.map((field) => ` && (${field})`).join('')})`;
    }
  }
}

export function csharpDomainCheck(domain: Domain, value = 'value', names = { next: 0 }): string {
  const text = `${value}.GetString()!`;
  switch (domain.kind) {
    case 'boolean': return `(${value}.ValueKind == JsonValueKind.True || ${value}.ValueKind == JsonValueKind.False)`;
    case 'integer': return `(${value}.ValueKind == JsonValueKind.String && ${text}.Length <= 128 && Regex.IsMatch(${text}, @"\\A(?:0|-?[1-9][0-9]*)\\z") && BigInteger.Parse(${text}, CultureInfo.InvariantCulture) >= BigInteger.Parse(${csharpLiteral(domain.min)}, CultureInfo.InvariantCulture) && BigInteger.Parse(${text}, CultureInfo.InvariantCulture) <= BigInteger.Parse(${csharpLiteral(domain.max)}, CultureInfo.InvariantCulture))`;
    case 'number': {
      const number = `number${names.next++}`;
      return `(${value}.ValueKind == JsonValueKind.Number && ${value}.TryGetDouble(out var ${number}) && double.IsFinite(${number}) && BitConverter.DoubleToInt64Bits(${number}) != long.MinValue && ${number} >= ${domain.min}d && ${number} <= ${domain.max}d)`;
    }
    case 'string': return `(${value}.ValueKind == JsonValueKind.String && ${text}.EnumerateRunes().Count() >= ${domain.minLength} && ${text}.EnumerateRunes().Count() <= ${domain.maxLength} && ${text}.EnumerateRunes().All(character => ${csharpLiteral(domain.alphabet)}.EnumerateRunes().Contains(character)))`;
    case 'enum': return `(${value}.ValueKind == JsonValueKind.String && new string[] { ${domain.values.map((item) => csharpLiteral(item)).join(', ')} }.Contains(${text}))`;
    case 'nullable': return `(${value}.ValueKind == JsonValueKind.Null || ${csharpDomainCheck(domain.value, value, names)})`;
    case 'array': {
      const item = `item${names.next++}`;
      return `(${value}.ValueKind == JsonValueKind.Array && ${value}.GetArrayLength() >= ${domain.minLength} && ${value}.GetArrayLength() <= ${domain.maxLength} && ${value}.EnumerateArray().All(${item} => ${csharpDomainCheck(domain.element, item, names)}))`;
    }
    case 'record': {
      const fields = Object.entries(domain.fields).map(([key, field]) => {
        const name = `field${names.next++}`;
        return `${value}.TryGetProperty(${csharpLiteral(key)}, out var ${name}) && ${csharpDomainCheck(field, name, names)}`;
      });
      return `(${value}.ValueKind == JsonValueKind.Object && ${value}.EnumerateObject().Count() == ${fields.length}${fields.map((field) => ` && (${field})`).join('')})`;
    }
  }
}
