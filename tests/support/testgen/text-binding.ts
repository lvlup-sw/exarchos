import { canonicalizeText } from '../../../src/contract/authority-digest.js';

export function isValid(input: string): boolean {
  return typeof input === 'string';
}

export function observe(input: string): string {
  return canonicalizeText(input);
}

export function reference(input: string): string {
  let normalized = '';
  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (character === '\r') {
      normalized += '\n';
      if (input[index + 1] === '\n') index++;
    } else {
      normalized += character;
    }
  }
  while (normalized.endsWith('\n')) normalized = normalized.slice(0, -1);
  return normalized;
}

export function predicate(input: string, observed: string): boolean {
  return observed === reference(input);
}

export function transform(input: string): string {
  return `${input}\n`;
}

export function relation(_source: string, _follow: string, before: string, after: string): boolean {
  return before === after;
}

export function equivalent(_input: string, actual: string, expected: string): boolean {
  return actual === expected;
}
