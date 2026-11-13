import type { Scenario, StatefulInput } from '../contract/stateful.js';
import type { Domain } from '../domains/schema.js';
import { domainProblem, inDomain } from '../domains/schema.js';
import { sample, seededRandom } from '../domains/generate.js';

export function statefulRequestProblem(input: StatefulInput): string | undefined {
  const names = new Set(input.operations.map((operation) => operation.name));
  if (names.size !== input.operations.length) return 'Operation names must be unique.';
  const domains = new Map(input.operations.map((operation) => [operation.name, operation.domain]));
  for (const domain of domains.values()) {
    const problem = domainProblem(domain);
    if (problem) return problem;
  }
  for (const history of input.histories) {
    for (const step of history) {
      const domain = domains.get(step.operation);
      if (!domain || !inDomain(domain, step.args)) return 'A history step has an unknown operation or invalid arguments.';
    }
  }
  if (!input.generation && input.histories.length === 0) return 'Supply histories or a generation budget.';
  if (input.generation) {
    if (input.generation.count < input.histories.length) return 'The generation count must include all supplied histories.';
    if (input.generation.maxAttempts < input.generation.maxSteps) return 'The attempt budget must permit the requested step count.';
    const argumentSize = Math.max(...input.operations.map((operation) => maximumEncodedSize(operation.domain)));
    const generatedSize = (input.generation.count - input.histories.length) * input.generation.maxAttempts * (argumentSize + 120);
    if (generatedSize + JSON.stringify(input.histories).length > 2_000_000) return 'The candidate-history budget exceeds two megabytes.';
  }
  return undefined;
}

export function generateHistories(input: StatefulInput): Scenario[] {
  const scenarios: Scenario[] = input.histories.map((steps) => ({ mode: 'exact', steps, requiredSteps: steps.length }));
  if (!input.generation) return scenarios;
  const random = seededRandom(input.generation.seed);
  while (scenarios.length < input.generation.count) {
    const steps = Array.from({ length: input.generation.maxAttempts }, () => {
      const operation = input.operations[Math.floor(random() * input.operations.length)]!;
      return { operation: operation.name, args: sample(operation.domain, random) };
    });
    scenarios.push({ mode: 'enabled', steps, requiredSteps: input.generation.maxSteps });
  }
  return scenarios;
}

function maximumEncodedSize(domain: Domain): number {
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
