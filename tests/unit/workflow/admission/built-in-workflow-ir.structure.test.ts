// The shared-IR workflow definitions and the translation that reads them must
// have no import path, direct or transitive, to a legacy guard module. The test
// walks the relative-import graph from the IR roots and checks that no
// forbidden module is reachable. A behavioral test cannot give this guarantee.

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

/** Legacy guard modules the shared IR must never reach. `state-machine.ts` imports `guards.ts`. */
const FORBIDDEN = [
  'workflow/guards.ts',
  'workflow/hsm-definitions.ts',
  'workflow/state-machine.ts',
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

/** Resolves a relative specifier to its `.ts` path. A bare specifier cannot be a local guard, so it gives null. */
function resolveTs(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  return base.replace(/\.js$/, '.ts');
}

/** Transitive closure of relative-import targets reachable from the roots. The walk skips a target that it cannot read. */
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
      continue;
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

  /** A broken walker that visits nothing proves independence trivially, so the walk must reach known modules. */
  it('reaches at least the known dependency graph (walker is not vacuous)', () => {
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
