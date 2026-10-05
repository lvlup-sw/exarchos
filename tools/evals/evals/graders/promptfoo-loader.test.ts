import { describe, it, expect, vi } from 'vitest';
import { getAssertions, PROMPTFOO_INSTALL_HINT } from './promptfoo-loader.js';

describe('promptfoo-loader', () => {
  describe('PROMPTFOO_INSTALL_HINT', () => {
    /** The hint names the eval package and the install command. */
    it('NamesTheOptInEvalPackageAndHowToInstall', () => {
      expect(PROMPTFOO_INSTALL_HINT.toLowerCase()).toContain('not installed');
      expect(PROMPTFOO_INSTALL_HINT).toContain('evals-pkg');
      expect(PROMPTFOO_INSTALL_HINT).toContain('install');
    });
  });

  describe('getAssertions', () => {
    it('EsmNamespaceWithAssertions_ReturnsAssertionsSurface', () => {
      const surface = { matchesLlmRubric: vi.fn(), matchesSimilarity: vi.fn() };
      expect(getAssertions({ assertions: surface })).toBe(surface);
    });

    /** A CJS-interop build puts the namespace under `default`, so the loader unwraps it. */
    it('CjsInteropDefaultWrapper_UnwrapsAndReturnsAssertions', () => {
      const surface = { matchesLlmRubric: vi.fn(), matchesSimilarity: vi.fn() };
      expect(getAssertions({ default: { assertions: surface } })).toBe(surface);
    });

    it('NoAssertions_ReturnsNull', () => {
      expect(getAssertions({ something: 'else' })).toBeNull();
      expect(getAssertions(null)).toBeNull();
      expect(getAssertions(undefined)).toBeNull();
      expect(getAssertions({ assertions: 'not-an-object' })).toBeNull();
    });
  });

  describe('loadPromptfooAssertions', () => {
    /** The test forces the bare import and the eval-package resolution to fail. */
    it('ModuleUnresolvable_ThrowsActionableInstallHint', async () => {
      vi.resetModules();
      vi.doMock('promptfoo', () => {
        throw new Error('Cannot find package promptfoo');
      });
      vi.doMock('node:module', () => ({
        createRequire: () => ({
          resolve: () => {
            throw new Error("Cannot find module 'promptfoo'");
          },
        }),
      }));

      const { loadPromptfooAssertions } = await import('./promptfoo-loader.js');
      await expect(loadPromptfooAssertions()).rejects.toThrow(/not installed/i);
      await expect(loadPromptfooAssertions()).rejects.toThrow(/evals-pkg/);

      vi.doUnmock('promptfoo');
      vi.doUnmock('node:module');
    });
  });
});
