import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY } from '../../registry.js';
import {
  buildOracleFromRegistry,
  extractToolExamples,
  validateExample,
  validateMarkdown,
  type SchemaOracle,
} from './skill-example-validator.js';

// A hand-built oracle keeps the unit tests deterministic and independent of the
// live registry's evolving action set. The `exarchos_workflow.run` action exercises
// every constrained property class: plain string, bounded integer, closed enum,
// and a 0..1 ratio (the DOC-3 "threshold documented as 80" shape).
const fakeOracle: SchemaOracle = {
  tools: {
    exarchos_workflow: {
      run: {
        properties: {
          name: { types: ['string'] },
          count: { types: ['integer'], minimum: 0, maximum: 10 },
          mode: { types: ['string'], enumValues: ['fast', 'slow'] },
          ratio: { types: ['number'], minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
    },
  },
};

function fence(body: string): string {
  return '```typescript\n' + body + '\n```';
}

function codes(md: string): string[] {
  return validateMarkdown(md, 'example.md', fakeOracle).map((i) => i.code);
}

describe('extractToolExamples', () => {
  it('parses a single-line call with an action discriminator and params', () => {
    const examples = extractToolExamples(
      fence('exarchos_workflow({ action: "run", name: "x", count: 5 })'),
      'example.md',
    );
    expect(examples).toHaveLength(1);
    expect(examples[0]?.tool).toBe('exarchos_workflow');
    expect(examples[0]?.action).toBe('run');
    expect(Object.keys(examples[0]?.params ?? {})).toEqual(['name', 'count']);
  });

  it('parses a multi-line call and skips a namespace prefix', () => {
    const examples = extractToolExamples(
      fence('mcp.exarchos_workflow({\n  action: "run",\n  name: "x",\n})'),
      'example.md',
    );
    expect(examples).toHaveLength(1);
    expect(examples[0]?.action).toBe('run');
  });

  it('treats a blockquoted example as a real example (blockquote prefix stripped)', () => {
    const md = '> ```typescript\n> exarchos_workflow({ action: "run", name: "x" })\n> ```';
    const examples = extractToolExamples(md, 'example.md');
    expect(examples).toHaveLength(1);
    expect(examples[0]?.action).toBe('run');
  });
});

describe('validateExample against a fake oracle — seeded drift FAILS', () => {
  it('flags an unknown tool', () => {
    expect(codes(fence('exarchos_view({ action: "run" })'))).toContain('UNKNOWN_TOOL');
  });

  it('flags a missing action discriminator', () => {
    expect(codes(fence('exarchos_workflow({ name: "x" })'))).toContain('MISSING_ACTION');
  });

  it('flags an unknown action', () => {
    expect(codes(fence('exarchos_workflow({ action: "fly" })'))).toContain('UNKNOWN_ACTION');
  });

  it('flags an unknown / misspelled param', () => {
    expect(codes(fence('exarchos_workflow({ action: "run", bogusParam: "x" })'))).toContain(
      'UNKNOWN_PARAM',
    );
  });

  it('flags a type-incompatible literal', () => {
    expect(codes(fence('exarchos_workflow({ action: "run", count: "notanumber" })'))).toContain(
      'TYPE_MISMATCH',
    );
  });

  it('flags a value outside a closed enum', () => {
    expect(codes(fence('exarchos_workflow({ action: "run", mode: "medium" })'))).toContain(
      'ENUM_MISMATCH',
    );
  });

  it('flags an integer above the declared maximum', () => {
    expect(codes(fence('exarchos_workflow({ action: "run", count: 80 })'))).toContain('RANGE_MISMATCH');
  });

  it('flags a 0..1 ratio documented as a percentage (DOC-3 shape)', () => {
    expect(codes(fence('exarchos_workflow({ action: "run", ratio: 80 })'))).toContain('RANGE_MISMATCH');
  });
});

describe('validateExample against a fake oracle — well-formed examples PASS', () => {
  it('accepts a fully-valid example', () => {
    const md = fence(
      'exarchos_workflow({ action: "run", name: "x", count: 5, mode: "fast", ratio: 0.5 })',
    );
    expect(validateMarkdown(md, 'example.md', fakeOracle)).toEqual([]);
  });

  it('treats a <placeholder> string as a type/range wildcard', () => {
    // Docs use "<n>" for every field regardless of the real type; this must not
    // be type- or range-checked, or the drift guard would flood false positives.
    const md = fence('exarchos_workflow({ action: "run", count: "<n>", ratio: "<ratio>" })');
    expect(validateMarkdown(md, 'example.md', fakeOracle)).toEqual([]);
  });

  it('accepts an in-range boundary integer', () => {
    expect(validateMarkdown(fence('exarchos_workflow({ action: "run", count: 0 })'), 'x.md', fakeOracle)).toEqual([]);
    expect(validateMarkdown(fence('exarchos_workflow({ action: "run", count: 10 })'), 'x.md', fakeOracle)).toEqual([]);
  });
});

describe('validateExample against the LIVE registry — seeded drift FAILS', () => {
  const oracle = buildOracleFromRegistry(TOOL_REGISTRY);

  it('flags a stale/retired action name (reconstruct_stack → validate_pr_stack)', () => {
    const md = fence('exarchos_orchestrate({ action: "reconstruct_stack", baseBranch: "main" })');
    const issues = validateMarkdown(md, 'seed.md', oracle);
    expect(issues.some((i) => i.code === 'UNKNOWN_ACTION')).toBe(true);
  });

  it('flags an unknown param on a real action', () => {
    const md = fence(
      'exarchos_orchestrate({ action: "serialize_merge", featureId: "f", integrationRef: "i", sourceBranch: "s", strategy: "squash", bogusParam: 1 })',
    );
    const issues = validateMarkdown(md, 'seed.md', oracle);
    expect(issues.some((i) => i.code === 'UNKNOWN_PARAM' && i.param === 'bogusParam')).toBe(true);
  });

  it('flags a 0..1 threshold documented as 80 (real bounded param)', () => {
    const md = fence('exarchos_orchestrate({ action: "mutation-adequacy", threshold: 80 })');
    const issues = validateMarkdown(md, 'seed.md', oracle);
    expect(issues.some((i) => i.code === 'RANGE_MISMATCH' && i.param === 'threshold')).toBe(true);
  });

  it('flags a value outside a real enum (strategy)', () => {
    const md = fence(
      'exarchos_orchestrate({ action: "serialize_merge", featureId: "f", integrationRef: "i", sourceBranch: "s", strategy: "fast-forward" })',
    );
    const issues = validateMarkdown(md, 'seed.md', oracle);
    expect(issues.some((i) => i.code === 'ENUM_MISMATCH' && i.param === 'strategy')).toBe(true);
  });
});

// ─── Exit-proof (b): every real documented example agrees with live schemas ──
// This is the WFQ-011 drift guard. Reverting any of the skills-src corrections
// made in P02-07 re-introduces a documented example that this walk rejects.
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Task 012 moved this file one level deeper (quality/ -> projections/quality/).
const REPO_ROOT = path.resolve(HERE, '../../..');

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

describe('live documentation ↔ registered schema agreement (WFQ-011 drift guard)', () => {
  const oracle = buildOracleFromRegistry(TOOL_REGISTRY);
  const docRoots = ['skills-src', 'commands'].map((r) => path.join(REPO_ROOT, r));

  it('every exarchos_* example in skills-src/ and commands/ validates clean', () => {
    const failures: string[] = [];
    let exampleCount = 0;
    for (const root of docRoots) {
      for (const file of walkMarkdown(root)) {
        const md = readFileSync(file, 'utf8');
        const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
        exampleCount += extractToolExamples(md, rel).length;
        for (const issue of validateMarkdown(md, rel, oracle)) {
          failures.push(`${issue.file}:${issue.line} [${issue.code}] ${issue.message}`);
        }
      }
    }
    // Guard against the extractor silently matching nothing (which would make
    // the "clean" assertion vacuously true).
    expect(exampleCount).toBeGreaterThan(0);
    expect(failures, `documented examples drifted from live schemas:\n${failures.join('\n')}`).toEqual([]);
  });
});

// validateExample is also exercised directly to pin its ToolExample contract.
describe('validateExample direct contract', () => {
  it('returns no issues for a valid hand-built example', () => {
    const [example] = extractToolExamples(
      fence('exarchos_workflow({ action: "run", name: "ok" })'),
      'x.md',
    );
    expect(example).toBeDefined();
    expect(validateExample(example!, fakeOracle)).toEqual([]);
  });
});
