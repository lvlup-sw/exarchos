import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/registry.js', () => ({
  TOOL_REGISTRY: [],
}));

/** A dynamic import, so the module loads after `vi.mock` replaces the registry with an empty array. */
const { generateDocsMarkdown } = await import('../../../tools/audit/core/generate-docs.js');

/** Replaces the content of the mocked `TOOL_REGISTRY` array in place, then renders the docs. */
async function generateWithRegistry(registry: unknown[]): Promise<string> {
  const mod = await import('../../../src/registry.js');
  const arr = mod.TOOL_REGISTRY as unknown[];
  arr.length = 0;
  arr.push(...registry);
  return generateDocsMarkdown();
}

describe('generate-docs', () => {
  describe('pipe character escaping', () => {
    it('should escape pipe characters in composite descriptions', async () => {
      const registry = [
        {
          name: 'exarchos_test',
          description: 'Does this | that',
          actions: [],
        },
      ];

      const result = await generateWithRegistry(registry);

      expect(result).toContain('Does this \\| that');
      expect(result).not.toMatch(/\| Does this \| that \|/);
    });

    it('should escape pipe characters in action descriptions', async () => {
      const registry = [
        {
          name: 'exarchos_test',
          description: 'Safe description',
          actions: [
            {
              name: 'test_action',
              description: 'Input | Output',
              phases: new Set(['ideate']),
              roles: new Set(['orchestrator']),
            },
          ],
        },
      ];

      const result = await generateWithRegistry(registry);

      expect(result).toContain('Input \\| Output');
    });

    it('should escape multiple pipe characters in a single description', async () => {
      const registry = [
        {
          name: 'exarchos_test',
          description: 'A | B | C',
          actions: [],
        },
      ];

      const result = await generateWithRegistry(registry);

      expect(result).toContain('A \\| B \\| C');
    });

    it('should leave descriptions without pipes unchanged', async () => {
      const registry = [
        {
          name: 'exarchos_test',
          description: 'Normal description',
          actions: [],
        },
      ];

      const result = await generateWithRegistry(registry);

      expect(result).toContain('Normal description');
    });
  });

  describe('phase derivation', () => {
    it('should derive phases from registry actions and include all in phase mappings', async () => {
      const registry = [
        {
          name: 'exarchos_workflow',
          description: 'Workflow management',
          actions: [
            {
              name: 'init',
              description: 'Initialize workflow',
              phases: new Set(['ideate', 'triage', 'explore']),
              roles: new Set(['lead']),
            },
            {
              name: 'get',
              description: 'Read state',
              phases: new Set(['ideate', 'delegate', 'polish-implement']),
              roles: new Set(['any']),
            },
          ],
        },
      ];

      const result = await generateWithRegistry(registry);

      expect(result).toContain('| delegate |');
      expect(result).toContain('| explore |');
      expect(result).toContain('| ideate |');
      expect(result).toContain('| polish-implement |');
      expect(result).toContain('| triage |');
    });

    it('should show "all" when an action covers every derived phase', async () => {
      const registry = [
        {
          name: 'exarchos_test',
          description: 'Test tool',
          actions: [
            {
              name: 'action_a',
              description: 'Covers all phases',
              phases: new Set(['alpha', 'beta']),
              roles: new Set(['any']),
            },
            {
              name: 'action_b',
              description: 'Also covers all',
              phases: new Set(['alpha', 'beta']),
              roles: new Set(['any']),
            },
          ],
        },
      ];

      const result = await generateWithRegistry(registry);

      expect(result).toContain('| `action_a` | Covers all phases | all |');
      expect(result).toContain('| `action_b` | Also covers all | all |');
    });
  });
});
