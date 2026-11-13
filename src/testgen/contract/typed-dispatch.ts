import type { TypedInput, TypedMethod, TypedSuccess } from './typed.js';
import { canonicalJson, domainProblem, inDomain, maximumEncodedSize } from '../domains/schema.js';
import { generateCases } from '../domains/generate.js';
import { emitTypedVitest } from '../emitters/vitest/typed.js';
import { emitTypedTUnit } from '../emitters/tunit/typed.js';

export function typedRequestProblem(input: TypedInput): string | undefined {
  const domainError = domainProblem(input.domain);
  if (domainError) return domainError;
  if (input.cases.some((value) => !inDomain(input.domain, value))) return 'A supplied case is outside the declared domain.';
  if (new Set(input.cases.map(canonicalJson)).size !== input.cases.length) return 'Duplicate cases are not allowed.';
  if (input.cases.length === 0 && !input.generation) return 'Supply cases or a generation budget.';
  if (input.generation && input.cases.length > input.generation.count) return 'The generation count must include all supplied cases.';
  const generatedCount = (input.generation?.count ?? input.cases.length) - input.cases.length;
  const encodedSize = JSON.stringify(input.cases).length + generatedCount * (maximumEncodedSize(input.domain) + 1);
  if (encodedSize > 2_000_000) return 'The case budget exceeds two megabytes.';
  return undefined;
}

export function emitTyped(input: TypedInput, method: TypedMethod): TypedSuccess {
  const generated = input.generation
    ? generateCases(input.domain, input.cases, input.generation)
    : { cases: input.cases, attempts: 0, duplicates: 0, exhausted: false };
  if (JSON.stringify(generated.cases).length > 2_000_000) throw new Error('Generated fixtures exceed two megabytes.');
  const expanded = { ...input, cases: generated.cases };
  const source = expanded.framework === 'vitest' ? emitTypedVitest(expanded, method) : emitTypedTUnit(expanded, method);
  const lines = source.trimEnd().split('\n');
  const path = input.target.path;
  return {
    ok: true,
    contractVersion: 2,
    generatorVersion: input.framework === 'vitest' ? 'vitest/2' : 'tunit/2',
    patch: [
      `diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), '',
    ].join('\n'),
    fixture: { version: 2, domain: input.domain, cases: generated.cases },
    generation: {
      seed: input.generation?.seed ?? null,
      requested: input.generation?.count ?? input.cases.length,
      attempts: generated.attempts,
      duplicates: generated.duplicates,
      exhausted: generated.exhausted,
    },
    propertyRefs: [input.propertyRef],
    assumptions: input.assumptions,
    unresolvedObligations: [
      'Review the binding oracle and preconditions, compile the patch, and verify native discovery and assertion sensitivity.',
      'The declared domain is structural. Application preconditions are checked during native execution.',
      ...(generated.exhausted ? ['The generation attempt budget ended before the requested number of distinct cases was reached.'] : []),
    ],
    validation: input.framework === 'vitest'
      ? { executable: 'npm', args: ['exec', '--no', '--', 'vitest', 'run', path] }
      : { executable: 'dotnet', args: ['run', '--project', input.target.project, '-c', 'Release'] },
  };
}

export function inputWithinBudget(input: unknown): boolean {
  const pending = [{ value: input, depth: 0, leave: false }];
  const seen = new Set<object>();
  let nodes = 0;
  let textLength = 0;
  while (pending.length > 0) {
    const { value, depth, leave } = pending.pop()!;
    if (leave) {
      seen.delete(value as object);
      continue;
    }
    if (++nodes > 100_000 || depth > 32) return false;
    if (typeof value === 'string') textLength += value.length;
    if (textLength > 2_000_000) return false;
    if (value === null || typeof value !== 'object') continue;
    if (seen.has(value)) return false;
    seen.add(value);
    pending.push({ value, depth, leave: true });
    for (const [key, child] of Object.entries(value)) {
      textLength += key.length;
      pending.push({ value: child, depth: depth + 1, leave: false });
    }
  }
  return true;
}
