import { expect, it } from 'vitest';
import { detectLayerEdges, runLayerBoundaryCensus } from '../../src/architecture/layer-boundaries-seam.js';
import { lexModule } from '../../tools/test-helpers/module-lexer.js';

it('rejects generation imports outside the owned SDK seam', () => {
  const source = [
    "import '../contract/sdk/seam.js';",
    "import '../contract/capsule/exarchos-capsule.js';",
    "import '../workflow/playbooks.js';",
    "import '../storage/index.js';",
  ].join('\n');
  const edges = detectLayerEdges('testgen/negative-control.ts', source, lexModule);
  const report = runLayerBoundaryCensus(edges);
  expect(report.diagnostics.filter((entry) => entry.code === 'FORBIDDEN_IMPORT').map((entry) => entry.targetModule))
    .toEqual(['contract/capsule/exarchos-capsule.ts', 'workflow/playbooks.ts', 'storage/index.ts']);
});
