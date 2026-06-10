// ─── mock-boundary unit tests ────────────────────────────────────────────────
//
// Verification-ladder slice 1, task 025 (SIV-4 #1530). Covers the pure
// mock-detection + ownership cross-reference core in isolation. The gate
// registration (task 026) wires these findings into a steer affordance later;
// here we prove only the detection/classification logic.
//
// Empirical grounding (cited in the module JSDoc): Hora & Robbes, MSR '26 —
// coding agents add mocks in 36% of test commits vs 26% for humans, 95% the
// brittle `mock` double; an LLM mocks its own assumption of an unowned API.
// ────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import {
  detectMockFindings,
  type FileDiff,
  type MockFinding,
} from './mock-boundary.js';

// First-party globs as the resolved `.exarchos.yml` `ownership.firstParty`
// default would supply them to the gate.
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
        testDiff('servers/exarchos-mcp/src/orchestrate/foo.test.ts', [
          [12, "vi.mock('axios');"],
        ]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      expect(findings).toHaveLength(1);
      const f = findings[0];
      expect(f.file).toBe('servers/exarchos-mcp/src/orchestrate/foo.test.ts');
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
    it('does not flag a vi.mock whose relative specifier resolves under a first-party glob', () => {
      // foo.test.ts lives at servers/exarchos-mcp/src/orchestrate/; the relative
      // '../config/toolchains.js' resolves to servers/exarchos-mcp/src/config/
      // toolchains.js, which matches `servers/*/src/**`.
      const diff: readonly FileDiff[] = [
        testDiff('servers/exarchos-mcp/src/orchestrate/foo.test.ts', [
          [8, "vi.mock('../config/toolchains.js');"],
        ]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      // First-party mocks carry unowned:false; the gate filters them out, so the
      // module emits NO finding for an owned target.
      expect(findings.every((f) => f.unowned)).toBe(true);
      expect(findings).toHaveLength(0);
    });
  });

  describe('DetectMocks_HeuristicIdentifiers_AllDetected', () => {
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
      // Every member of the regex family is represented at least once.
      expect(new Set(identifiers)).toEqual(
        new Set(['mock', 'stub', 'spy', 'fake', 'patch', 'monkeypatch']),
      );
      // spyOn matches via the capital-letter identifier boundary (spy|On).
      expect(findings.some((f) => f.identifier === 'spy')).toBe(true);
    });

    it('does not flag family substrings buried inside an ordinary word (identifier boundary rule)', () => {
      // "inspect" contains "spect"→"spec"? no; it contains "spe"… the relevant
      // hazard is "spy" inside no common word and the substring rule. We assert
      // the boundary rule rejects substrings that continue with a lowercase
      // letter: e.g. "stubbornness", "fakery"-as-prose handled by the camelCase
      // boundary, and a bare prose mention without a call-site.
      const diff: readonly FileDiff[] = [
        testDiff('src/prose.test.ts', [
          [10, '// stubbornness is not a stub double'],
          [11, '// this comment mentions fakery and patchwork casually'],
          [12, 'const inspector = makeInspector();'],
        ]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      // None of stubbornness/fakery/patchwork/inspector are identifier-boundary
      // hits: each family word is immediately followed by another lowercase
      // letter, so the boundary rule rejects them.
      expect(findings).toHaveLength(0);
    });
  });

  describe('DetectMocks_SourceFileDiff_Ignored', () => {
    it('ignores mock identifiers that appear in SOURCE-file hunks', () => {
      const diff: readonly FileDiff[] = [
        // Source file (no test glob match) — mock call here is real production
        // code, not a test double, so detection must skip it.
        testDiff('src/orchestrate/foo.ts', [[5, "vi.mock('axios');"]]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      expect(findings).toHaveLength(0);
    });

    it('detects in the test file but not the source file when both change', () => {
      const diff: readonly FileDiff[] = [
        testDiff('src/orchestrate/foo.ts', [[5, "vi.mock('axios');"]]),
        testDiff('src/orchestrate/foo.test.ts', [[9, "jest.mock('axios');"]]),
      ];

      const findings = detectMockFindings(diff, { firstPartyGlobs: FIRST_PARTY });

      expect(findings).toHaveLength(1);
      expect(findings[0].file).toBe('src/orchestrate/foo.test.ts');
    });
  });

  describe('DetectMocks_ModuleSpecifierResolution_RelativeVsPackage', () => {
    it('resolves relative specifiers against the diff file path before ownership matching', () => {
      // From a test that lives OUTSIDE the first-party tree, a relative mock of
      // a sibling stays outside → unowned.
      const outside: readonly FileDiff[] = [
        testDiff('scripts/tools/foo.test.ts', [
          [4, "vi.mock('./bar.js');"],
        ]),
      ];
      const outsideFindings = detectMockFindings(outside, { firstPartyGlobs: FIRST_PARTY });
      expect(outsideFindings).toHaveLength(1);
      expect(outsideFindings[0].mockedTarget).toBe('scripts/tools/bar.js');
      expect(outsideFindings[0].unowned).toBe(true);

      // From a test INSIDE the first-party tree, a relative mock of a sibling
      // resolves under src/** → owned, filtered out.
      const inside: readonly FileDiff[] = [
        testDiff('src/orchestrate/foo.test.ts', [
          [4, "vi.mock('./bar.js');"],
        ]),
      ];
      const insideFindings = detectMockFindings(inside, { firstPartyGlobs: FIRST_PARTY });
      expect(insideFindings).toHaveLength(0);
    });

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

      // A workspace package declared first-party (its bare specifier matches a
      // glob) is owned → filtered out.
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

    it('honors a testGlobs override for classification', () => {
      const diff: readonly FileDiff[] = [
        // Not a .test.* file — only matched when the override names it.
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
