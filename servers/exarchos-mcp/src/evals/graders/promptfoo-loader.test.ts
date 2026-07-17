import { describe, it, expect, vi } from 'vitest';
import { getAssertions, PROMPTFOO_INSTALL_HINT } from './promptfoo-loader.js';

describe('promptfoo-loader', () => {
  describe('PROMPTFOO_INSTALL_HINT', () => {
    it('NamesTheOptInEvalPackageAndHowToInstall', () => {
      // The hint must be actionable (DR-3): name the eval package and the
      // install command, not an opaque module-not-found.
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

    it('CjsInteropDefaultWrapper_UnwrapsAndReturnsAssertions', () => {
      // Some builds expose the namespace under `default` — the loader must
      // unwrap it so the fallback file-URL import path works for CJS interop.
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
    it('ModuleUnresolvable_ThrowsActionableInstallHint', async () => {
      // Bare `import('promptfoo')` fails AND the eval-package fallback fails →
      // the loader must surface the actionable install hint, not an opaque
      // crash. Both seams are forced to fail deterministically here.
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
