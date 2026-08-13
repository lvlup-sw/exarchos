// ─── P07-02 exit-proof (b) — shared-IR structural independence ────────────────
//
// The shared-IR workflow definitions (and the translation that consumes them)
// must have NO import path — direct or transitive — to any LEGACY GUARD module.
// The legacy guard remains the authoritative decider until P07-05; what must be
// true NOW is that the new IR does not reach back into legacy guard code. This
// is proved STRUCTURALLY by walking the transitive relative-import graph from
// the IR roots and asserting no forbidden module is reachable — a guarantee a
// behavioural test cannot give.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_WORKFLOW_IR,
  BUILT_IN_WORKFLOW_TYPES,
  edgesForWorkflow,
} from '../../../../src/workflow/admission/built-in-workflow-ir.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Legacy guard modules the shared IR must never reach. */
const FORBIDDEN = [
  'workflow/guards.ts',
  'workflow/hsm-definitions.ts',
  'workflow/state-machine.ts', // imports guards.ts transitively
  'config/guards.ts',
  'config/register.ts',
];

function importSpecifiers(source: string): readonly string[] {
  const specs: string[] = [];
  const re = /(?:from|import)\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

function resolveTs(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // bare import — cannot be a local guard
  const base = resolve(dirname(fromFile), spec);
  return base.replace(/\.js$/, '.ts');
}

/** Transitive closure of relative-import targets reachable from the roots. */
function reachableModules(roots: readonly string[]): ReadonlySet<string> {
  const visited = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue; // unresolved (e.g. .json / type-only phantom) — nothing to walk
    }
    for (const spec of importSpecifiers(source)) {
      const target = resolveTs(file, spec);
      if (target !== null) queue.push(target);
    }
  }
  return visited;
}

describe('shared-IR structural independence (exit-proof b)', () => {
  const roots = [
    resolve(HERE, '../../../../src/workflow/admission/built-in-workflow-ir.ts'),
    resolve(HERE, '../../../../src/workflow/admission/legacy-state-translation.ts'),
  ];
  const reachable = reachableModules(roots);

  it('reaches at least the known dependency graph (walker is not vacuous)', () => {
    // Sanity: the walk actually traversed edges (otherwise a broken walker
    // would trivially "prove" independence).
    const asPosix = [...reachable].map((f) => f.replace(/\\/g, '/'));
    expect(asPosix.some((f) => f.endsWith('workflow/admission/edge-condition.ts'))).toBe(
      true,
    );
    expect(
      asPosix.some((f) => f.endsWith('workflow/admission/policy-evaluation.ts')),
    ).toBe(true);
  });

  it('reaches NO legacy guard module (direct or transitive)', () => {
    const asPosix = [...reachable].map((f) => f.replace(/\\/g, '/'));
    for (const forbidden of FORBIDDEN) {
      const hit = asPosix.find((f) => f.endsWith(forbidden));
      expect(hit, `shared IR must not reach ${forbidden}`).toBeUndefined();
    }
  });

  it('the IR module imports only the edge-condition AST and the phase-kind type', () => {
    const source = readFileSync(resolve(HERE, '../../../../src/workflow/admission/built-in-workflow-ir.ts'), 'utf8');
    const relative = importSpecifiers(source).filter((s) => s.startsWith('.'));
    expect(new Set(relative)).toEqual(
      new Set(['./edge-condition.js', '../phase-kind.js']),
    );
  });
});

describe('shared-IR coverage (exit-proof a support)', () => {
  it('expresses all five built-in workflows with edges', () => {
    expect(BUILT_IN_WORKFLOW_TYPES).toHaveLength(5);
    for (const wf of BUILT_IN_WORKFLOW_TYPES) {
      expect(edgesForWorkflow(wf).length, wf).toBeGreaterThan(0);
    }
  });

  it('covers all six phase kinds across the IR edges (cutover-gate coverage)', () => {
    const kinds = new Set(BUILT_IN_WORKFLOW_IR.map((e) => e.toPhaseKind));
    expect(kinds).toEqual(
      new Set(['PLAN', 'IMPLEMENT', 'REVIEW', 'SYNTHESIZE', 'MERGE', 'GATHER']),
    );
  });

  it('carries both gate and approval obligations plus pure-routing edges', () => {
    const kinds = new Set(BUILT_IN_WORKFLOW_IR.map((e) => e.obligation.kind));
    expect(kinds).toEqual(new Set(['none', 'gate', 'approval']));
  });

  it('never carries a live reference to guard code — legacyGuardId is a string label', () => {
    for (const edge of BUILT_IN_WORKFLOW_IR) {
      expect(
        edge.legacyGuardId === null || typeof edge.legacyGuardId === 'string',
        `${edge.workflowType}:${edge.from}:${edge.to}`,
      ).toBe(true);
    }
  });
});
