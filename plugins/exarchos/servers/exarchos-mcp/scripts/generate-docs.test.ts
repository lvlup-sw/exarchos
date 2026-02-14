import { describe, it, expect, vi } from 'vitest';

// Mock the registry before importing generate-docs
vi.mock('../src/registry.js', () => ({
  TOOL_REGISTRY: [],
}));

// Import after mocking
const { generateDocsMarkdown } = await import('./generate-docs.js');

// Helper to generate docs with a custom registry
async function generateWithRegistry(registry: unknown[]): Promise<string> {
  const mod = await import('../src/registry.js');
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

      // The pipe in the description should be escaped
      expect(result).toContain('Does this \\| that');
      // Should NOT contain unescaped pipe within cell content
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

      // The pipe in the action description should be escaped
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
});
