// Tests the pure mock-detection and ownership core of the mock-boundary gate.
// The detector flags a mock in a test-file diff when its target is outside the
// first-party globs.

import { describe, it, expect } from 'vitest';
import {
  detectMockFindings,
  type FileDiff,
  type MockFinding,
} from '../../../../src/verbs/gates/mock-boundary.js';

/** The default first-party globs from the configuration schema. */
const FIRST_PARTY: readonly string[] = ['src/**', 'servers/*/src/**'];

/** Build a test-file diff entry from a list of added (line, text) tuples. */
function testDiff(path: string, lines: ReadonlyArray<readonly [number, string]>): FileDiff {
  return {
    path,
    addedLines: lines.map(([line, text]) => ({ line, text })),
  };
}

describe('detectMockFindings', () => {
  describe('DetectMocks_MockOfUnownedDep_Flagged', () => {
    it('flags a test-file diff that adds vi.mock of an npm package as unowned', () => {
      const diff: readonly FileDiff[] = [
        testDiff('src/verbs/foo.test.ts', [
          [12, "vi.mock('axios');"],
        ]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      expect(findings).toHaveLength(1);
      const f = findings[0];
      expect(f.file).toBe('src/verbs/foo.test.ts');
      expect(f.mockedTarget).toBe('axios');
      expect(f.unowned).toBe(true);
      expect(f.identifier).toBe('mock');
      expect(f.line).toBe(12);
    });

    it('flags jest.mock of an npm package the same way', () => {
      const diff: readonly FileDiff[] = [
        testDiff('src/a.test.ts', [[3, "jest.mock('lodash');"]]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      expect(findings).toHaveLength(1);
      expect(findings[0].mockedTarget).toBe('lodash');
      expect(findings[0].unowned).toBe(true);
    });
  });

  describe('DetectMocks_FirstPartyMock_Allowed', () => {
    /**
     * From `src/verbs/`, the relative `../config/toolchains.js` resolves to
     * `src/config/toolchains.js`, which is first-party. An owned target gives no
     * finding.
     */
    it('does not flag a vi.mock whose relative specifier resolves under a first-party glob', () => {
      const diff: readonly FileDiff[] = [
        testDiff('src/verbs/foo.test.ts', [
          [8, "vi.mock('../config/toolchains.js');"],
        ]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      expect(findings.every((f) => f.unowned)).toBe(true);
      expect(findings).toHaveLength(0);
    });
  });

  describe('DetectMocks_HeuristicIdentifiers_AllDetected', () => {
    /** Each identifier family matches at least once. `spyOn` matches at the capital-letter boundary. */
    it('catches the representative mock/stub/spy/fake/patch/monkeypatch forms', () => {
      const diff: readonly FileDiff[] = [
        testDiff('src/heuristics.test.ts', [
          [1, "vi.mock('axios');"],
          [2, "jest.mock('react');"],
          [3, "sinon.stub(net, 'connect');"],
          [4, "vi.spyOn(globalThis, 'fetch');"],
          [5, '    monkeypatch.setattr(os, "getcwd", fake)'],
          [6, "const f = createFake('redis');"],
          [7, "patch('requests.get');"],
        ]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      const identifiers = findings.map((f) => f.identifier).sort();
      expect(new Set(identifiers)).toEqual(
        new Set(['mock', 'stub', 'spy', 'fake', 'patch', 'monkeypatch']),
      );
      expect(findings.some((f) => f.identifier === 'spy')).toBe(true);
    });

    /**
     * A family word followed by a lowercase letter is part of a longer word, so
     * `stubbornness`, `fakery`, `patchwork` and `spying` do not match.
     */
    it('does not flag family substrings buried inside a longer ordinary word (trailing-lowercase boundary rule)', () => {
      const diff: readonly FileDiff[] = [
        testDiff('src/prose.test.ts', [
          [10, '// stubbornness should never be confused with a double'],
          [11, '// this comment mentions fakery and patchwork casually'],
          [12, 'const spying = observeBehaviour();'],
        ]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      expect(findings).toHaveLength(0);
    });

    /**
     * The leading boundary is permissive: a standalone family word matches even
     * in a comment. The test pins this accepted false positive.
     */
    it('DOES flag a standalone family word in prose (documented precision tradeoff)', () => {
      const diff: readonly FileDiff[] = [
        testDiff('src/prose.test.ts', [
          [3, "// we stub 'axios' here for now"],
        ]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      expect(findings).toHaveLength(1);
      expect(findings[0].identifier).toBe('stub');
      expect(findings[0].mockedTarget).toBe('axios');
    });
  });

  describe('DetectMocks_SourceFileDiff_Ignored', () => {
    /** A mock call in a source file is production code, not a test double. */
    it('ignores mock identifiers that appear in SOURCE-file hunks', () => {
      const diff: readonly FileDiff[] = [
        testDiff('src/verbs/foo.ts', [[5, "vi.mock('axios');"]]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      expect(findings).toHaveLength(0);
    });

    it('detects in the test file but not the source file when both change', () => {
      const diff: readonly FileDiff[] = [
        testDiff('src/verbs/foo.ts', [[5, "vi.mock('axios');"]]),
        testDiff('src/verbs/foo.test.ts', [[9, "jest.mock('axios');"]]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      expect(findings).toHaveLength(1);
      expect(findings[0].file).toBe('src/verbs/foo.test.ts');
    });
  });

  describe('DetectMocks_ModuleSpecifierResolution_RelativeVsPackage', () => {
    /**
     * From a test outside the first-party tree, a relative mock of a sibling is
     * unowned. From a test inside `src/`, the same mock is owned and gives no finding.
     */
    it('resolves relative specifiers against the diff file path before ownership matching', () => {
      const outside: readonly FileDiff[] = [
        testDiff('scripts/tools/foo.test.ts', [
          [4, "vi.mock('./bar.js');"],
        ]),
      ];
      const outsideFindings = detectMockFindings(outside, { firstPartyGlobs: FIRST_PARTY });
      expect(outsideFindings).toHaveLength(1);
      expect(outsideFindings[0].mockedTarget).toBe('scripts/tools/bar.js');
      expect(outsideFindings[0].unowned).toBe(true);

      const inside: readonly FileDiff[] = [
        testDiff('src/verbs/foo.test.ts', [
          [4, "vi.mock('./bar.js');"],
        ]),
      ];
      const insideFindings = detectMockFindings(inside, { firstPartyGlobs: FIRST_PARTY });
      expect(insideFindings).toHaveLength(0);
    });

    /** A first-party glob that matches a bare package specifier makes that package owned. */
    it('treats a bare package specifier as unowned unless a first-party glob matches it', () => {
      const diff: readonly FileDiff[] = [
        testDiff('src/a.test.ts', [
          [1, "vi.mock('axios');"],
          [2, "vi.mock('@scope/pkg');"],
        ]),
      ];

      const baseFindings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });
      expect(baseFindings).toHaveLength(2);
      expect(baseFindings.every((f) => f.unowned)).toBe(true);

      const withWorkspace = detectMockFindings(diff, {
        firstPartyGlobs: [...FIRST_PARTY, '@scope/**'],
      });
      expect(withWorkspace).toHaveLength(1);
      expect(withWorkspace[0].mockedTarget).toBe('axios');
    });
  });

  describe('finding shape', () => {
    it('carries file, line, identifier, mockedTarget, and unowned', () => {
      const diff: readonly FileDiff[] = [
        testDiff('src/a.test.ts', [[7, "vi.mock('axios');"]]),
      ];
      const [finding]: readonly MockFinding[] = detectMockFindings(diff, {
        firstPartyGlobs: FIRST_PARTY,
      });
      expect(finding).toEqual({
        file: 'src/a.test.ts',
        line: 7,
        identifier: 'mock',
        mockedTarget: 'axios',
        unowned: true,
      });
    });

    /** `src/specs/a.checks.ts` is not a test file by default. Only the `testGlobs` override classifies it. */
    it('honors a testGlobs override for classification', () => {
      const diff: readonly FileDiff[] = [
        testDiff('src/specs/a.checks.ts', [[1, "vi.mock('axios');"]]),
      ];
      const withDefault = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });
      expect(withDefault).toHaveLength(0);

      const withOverride = detectMockFindings(diff, {
        firstPartyGlobs: FIRST_PARTY,
        testGlobs: ['**/*.checks.ts'],
      });
      expect(withOverride).toHaveLength(1);
    });
  });
});
