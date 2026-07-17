// ─── mock-boundary — mock detection + ownership cross-reference (SIV-4 #1530) ─
//
// Verification-ladder slice 1, task 025. Pure core for the mock-boundary gate.
//
// EMPIRICAL GROUNDING. Hora & Robbes, "Do Coding Agents Mock Differently?"
// (MSR '26): coding agents add mocks in 36% of test commits vs 26% for humans,
// and 95% of those are the brittle `mock` double rather than a real fixture.
// The failure mode is an LLM mocking its OWN assumption of an API it does not
// own — it invents a boundary around a dependency it never read, so the test
// asserts against a fiction. Mocking a FIRST-PARTY module is far less risky:
// it is authored here, its contract is visible, and the mock can be checked
// against the real thing. Mocking an UNOWNED dependency (an npm package, a
// vendored tree) is the high-risk pattern this module surfaces.
//
// SCOPE. This module is the PURE core: callers supply the diff, the resolved
// first-party globs, and (optionally) the test globs. No fs, no git, no config
// loads — the gate registration (task 026) wires those in. Detection is scoped
// to TEST-file hunks by reusing `splitHunks` (task 011) so mock calls in real
// production source are never flagged.
//
// IDENTIFIER-BOUNDARY RULE (documented + tested). The detection family is
// `mock | stub | spy | fake | patch | monkeypatch`, matched case-insensitively
// but only at an IDENTIFIER boundary, so ordinary prose words that merely
// contain a family substring are not flagged. Concretely, a family word counts
// as a hit iff:
//   • LEADING boundary — it is preceded by a non-lowercase-letter character
//     (start-of-line, whitespace, `.`, `(`, `'`, etc.) OR it begins with an
//     uppercase letter (a camelCase hump, e.g. the `Fake` in `createFake`); AND
//   • TRAILING boundary — the character immediately after it is NOT a lowercase
//     letter (so `mock(`, `spyOn`, `monkeypatch.` hit, but `stubbornness`,
//     `fakery`, `patchwork` do not — each continues into another lowercase
//     letter and is therefore rejected as a longer ordinary word).
// This is the ~94%-precision heuristic the design calls for; perfection is not
// required, and the trailing-lowercase rule is the load-bearing false-positive
// guard (a comment that says "spying" still would not hit because `spy` is
// followed by lowercase `i`).
// ────────────────────────────────────────────────────────────────────────────

import { splitHunks } from './test-adequacy.js';

// ─── public types ────────────────────────────────────────────────────────────

/** A single added line of a changed file, with its post-image line number. */
export interface AddedLine {
  /** 1-based line number in the file's post-image (new side of the diff). */
  readonly line: number;
  /** The added line's text (without the leading `+`). */
  readonly text: string;
}

/**
 * One changed file from the task diff, paired with the lines it ADDS. This is
 * the richer companion to the file-path list `splitHunks` consumes: the path is
 * forwarded to `splitHunks` for test/source classification, and `addedLines`
 * supplies the content the detector scans. Removed/context lines are not
 * carried — a mock the diff DELETES is not a new mock and is never flagged.
 */
export interface FileDiff {
  /** Repo-relative path of the changed file. */
  readonly path: string;
  /** Lines this diff adds to the file (new side only). */
  readonly addedLines: readonly AddedLine[];
}

/** The detection family, in priority order (longest-specific first). */
export type MockIdentifier = 'monkeypatch' | 'mock' | 'stub' | 'spy' | 'fake' | 'patch';

/**
 * A detected mock site. Carries enough to build the steer affordance later
 * (task 026): which file/line, which detection identifier fired, the mocked
 * target as written, and whether that target is UNOWNED (outside the resolved
 * first-party scope) — the high-risk case the gate steers on.
 */
export interface MockFinding {
  /** Repo-relative path of the test file the mock was added to. */
  readonly file: string;
  /** 1-based post-image line of the mock site, when known. */
  readonly line?: number;
  /** The detection-family identifier that fired (e.g. `mock`, `spy`). */
  readonly identifier: MockIdentifier;
  /**
   * The mocked target as cross-referenced against ownership: a RELATIVE
   * specifier is resolved against the diff file's directory (`./bar.js` from
   * `scripts/tools/foo.test.ts` → `scripts/tools/bar.js`); a BARE package
   * specifier is carried verbatim (`axios`, `@scope/pkg`). This is the exact
   * string matched against the first-party globs, so the steer affordance can
   * show the operator what scope the mock fell into.
   */
  readonly mockedTarget: string;
  /** True when the target resolves OUTSIDE the first-party glob scope. */
  readonly unowned: boolean;
}

export interface DetectMockOptions {
  /**
   * Resolved `ownership.firstParty` globs (the gate supplies these from config;
   * the module does NOT load config). A mocked target that resolves to a path
   * matching any of these globs is OWNED and filtered out of the findings.
   */
  readonly firstPartyGlobs: readonly string[];
  /**
   * Optional test-glob override forwarded to {@link splitHunks}. When omitted
   * the co-located defaults are used. Detection only scans files `splitHunks`
   * classifies as tests.
   */
  readonly testGlobs?: readonly string[];
}

// ─── glob matching (mirrors splitHunks' minimal engine) ──────────────────────
//
// We re-derive a small glob→RegExp here rather than import splitHunks' private
// `globToRegExp`: that helper is intentionally module-private, and ownership
// globs may name BARE package specifiers (e.g. `@scope/**`) that never contain
// a `/`-prefixed repo path, so the matcher must also apply to non-path targets.

/**
 * Translate one glob into a whole-string-anchored RegExp. Supports the same
 * minimal token set as `splitHunks`: `**`/`**​/` (any number of segments), `*`
 * (a run of non-`/` chars), every other character literal.
 */
function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? '';
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  out += '$';
  return new RegExp(out);
}

// ─── module-specifier resolution ─────────────────────────────────────────────

/**
 * Resolve a mock's module specifier to the string that ownership globs are
 * matched against.
 *
 *   • RELATIVE specifiers (`./x`, `../x`) resolve against the DIRECTORY of the
 *     diff file, normalizing `.`/`..` segments, so `vi.mock('../config/x.js')`
 *     in `servers/m/src/orchestrate/foo.test.ts` becomes
 *     `servers/m/src/config/x.js` before glob matching.
 *   • BARE package specifiers (`axios`, `@scope/pkg`) are returned verbatim —
 *     they only count as owned if a first-party glob is written to match the
 *     specifier itself (e.g. a workspace package glob `@scope/**`).
 */
function resolveSpecifier(specifier: string, fromFile: string): string {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  if (!isRelative) {
    return specifier;
  }

  const fromDir = fromFile.includes('/')
    ? fromFile.slice(0, fromFile.lastIndexOf('/'))
    : '';
  const baseSegments = fromDir ? fromDir.split('/') : [];

  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      baseSegments.pop();
      continue;
    }
    baseSegments.push(segment);
  }

  return baseSegments.join('/');
}

// ─── mock-site detection ─────────────────────────────────────────────────────

/**
 * Identifier-family detector. Returns the family identifier present at an
 * identifier boundary in `text`, or `undefined`. `monkeypatch` is tried before
 * `patch` so a `monkeypatch` site reports the more specific identifier. See the
 * IDENTIFIER-BOUNDARY RULE in the module header for the boundary semantics.
 */
const FAMILY: readonly MockIdentifier[] = ['monkeypatch', 'mock', 'stub', 'spy', 'fake', 'patch'];

function isLowerLetter(ch: string | undefined): boolean {
  return ch !== undefined && ch >= 'a' && ch <= 'z';
}

function isUpperLetter(ch: string | undefined): boolean {
  return ch !== undefined && ch >= 'A' && ch <= 'Z';
}

/**
 * Find the first family identifier at an identifier boundary in `text`.
 * Case-insensitive. Boundary rule (see module header):
 *   • leading: preceding char is NOT a lowercase letter, OR the matched word
 *     begins with an uppercase letter (camelCase hump);
 *   • trailing: following char is NOT a lowercase letter.
 */
function detectIdentifier(text: string): MockIdentifier | undefined {
  const lower = text.toLowerCase();
  let best: { identifier: MockIdentifier; index: number } | undefined;

  for (const word of FAMILY) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(word, from);
      if (idx === -1) break;
      from = idx + 1;

      const prev = idx > 0 ? text[idx - 1] : undefined;
      const next = idx + word.length < text.length ? text[idx + word.length] : undefined;
      const first = text[idx];

      const leadingOk = !isLowerLetter(prev) || isUpperLetter(first);
      const trailingOk = !isLowerLetter(next);

      if (leadingOk && trailingOk) {
        if (best === undefined || idx < best.index) {
          best = { identifier: word, index: idx };
        }
        break;
      }
    }
  }

  return best?.identifier;
}

/**
 * Extract the mocked target's module specifier from a detected mock site. We
 * pull the FIRST single- or double-quoted string literal on the line — the
 * near-universal shape of `vi.mock('x')`, `jest.mock("x")`, `sinon.stub(net,
 * 'connect')`, `monkeypatch.setattr(os, "getcwd", …)`. When no literal is
 * present the whole trimmed line is returned so the finding still names a
 * target.
 */
function extractTarget(text: string): string {
  const match = text.match(/['"]([^'"]+)['"]/);
  return match?.[1] ?? text.trim();
}

// ─── public entry point ──────────────────────────────────────────────────────

/**
 * Detect mock sites in a task diff and cross-reference each against the
 * resolved first-party ownership scope. Pure: no fs/git/config access — the
 * caller supplies the diff, the first-party globs, and (optionally) the test
 * globs.
 *
 * Pipeline:
 *   1. classify changed files into test vs source via {@link splitHunks};
 *   2. for each TEST file, scan its added lines for a family identifier at an
 *      identifier boundary;
 *   3. extract the mocked target specifier and resolve it (relative → repo
 *      path; bare → verbatim);
 *   4. mark `unowned` when the resolved target matches NO first-party glob;
 *   5. emit ONLY unowned findings — first-party mocks (`unowned:false`) are
 *      filtered out, since mocking owned code is the low-risk case.
 *
 * @returns the unowned mock findings, in diff order.
 */
export function detectMockFindings(
  diff: readonly FileDiff[],
  opts: DetectMockOptions,
): readonly MockFinding[] {
  const paths = diff.map((d) => d.path);
  const { testFiles } = splitHunks(paths, { testGlobs: opts.testGlobs });
  const testFileSet = new Set(testFiles);

  const ownerMatchers = opts.firstPartyGlobs.map(globToRegExp);
  const findings: MockFinding[] = [];

  for (const fileDiff of diff) {
    if (!testFileSet.has(fileDiff.path)) {
      continue; // source-file hunk — never flagged
    }

    for (const added of fileDiff.addedLines) {
      const identifier = detectIdentifier(added.text);
      if (identifier === undefined) {
        continue;
      }

      const rawTarget = extractTarget(added.text);
      const resolved = resolveSpecifier(rawTarget, fileDiff.path);
      const owned = ownerMatchers.some((re) => re.test(resolved));

      if (owned) {
        continue; // first-party mock — low risk, filtered out
      }

      findings.push({
        file: fileDiff.path,
        line: added.line,
        identifier,
        mockedTarget: resolved,
        unowned: true,
      });
    }
  }

  return findings;
}
