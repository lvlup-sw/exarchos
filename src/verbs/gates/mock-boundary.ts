/**
 * mock-boundary: the pure core of the mock-boundary gate. It finds the mock
 * sites that a diff adds to test files. It reports each mock whose target is
 * outside the first-party scope.
 *
 * A mock of an unowned dependency (an npm package, a vendored tree) is the
 * high-risk case. An agent can mock its own wrong idea of an API that it never
 * read. A first-party mock is low risk, because its contract is
 * visible here. The caller supplies the diff, the first-party globs, and
 * optionally the test globs. This module reads no files, runs no git, and loads no config.
 *
 * The detection family is `mock`, `stub`, `spy`, `fake`, `patch`, and
 * `monkeypatch`, matched case-insensitively at an identifier boundary. See
 * {@link detectIdentifier} for the boundary rule.
 */

import { splitHunks } from './test-adequacy.js';

/** A single added line of a changed file, with its post-image line number. */
export interface AddedLine {
  /** 1-based line number in the file's post-image (new side of the diff). */
  readonly line: number;
  /** The added line's text (without the leading `+`). */
  readonly text: string;
}

/**
 * One changed file from the task diff and the lines that it adds. The path
 * goes to `splitHunks` for test or source classification. The detector scans
 * `addedLines`. A mock that the diff deletes is not a new mock, so removed
 * lines are not carried.
 */
export interface FileDiff {
  /** Repo-relative path of the changed file. */
  readonly path: string;
  /** Lines this diff adds to the file (new side only). */
  readonly addedLines: readonly AddedLine[];
}

/** A detection-family identifier. */
export type MockIdentifier = 'monkeypatch' | 'mock' | 'stub' | 'spy' | 'fake' | 'patch';

/**
 * A detected mock site: the file and line, the identifier that fired, the
 * mocked target, and whether the target is outside the first-party scope.
 */
export interface MockFinding {
  /** Repo-relative path of the test file the mock was added to. */
  readonly file: string;
  /** 1-based post-image line of the mock site, when known. */
  readonly line?: number;
  /** The detection-family identifier that fired, for example `mock` or `spy`. */
  readonly identifier: MockIdentifier;
  /**
   * The mocked target as matched against the first-party globs. A relative
   * specifier resolves against the directory of the diff file, so `./bar.js`
   * from `scripts/tools/foo.test.ts` gives `scripts/tools/bar.js`. A bare
   * package specifier stays as written (`axios`, `@scope/pkg`).
   */
  readonly mockedTarget: string;
  /** True when the target resolves OUTSIDE the first-party glob scope. */
  readonly unowned: boolean;
}

export interface DetectMockOptions {
  /**
   * Resolved `ownership.firstParty` globs from the gate. A mocked target that
   * matches one of these globs is owned and is not reported.
   */
  readonly firstPartyGlobs: readonly string[];
  /**
   * Optional test-glob override for {@link splitHunks}. If omitted, the
   * co-located defaults apply. Detection scans only the files that `splitHunks`
   * classifies as tests.
   */
  readonly testGlobs?: readonly string[];
}

/**
 * Translates one glob into a RegExp anchored to the whole string. It supports
 * the same tokens as `splitHunks`. A double star matches any number of
 * segments, `*` matches a run of non-`/` characters, and every other character
 * is literal. This is a local copy because the `splitHunks` helper is
 * module-private, and because ownership globs can name bare package specifiers.
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

/**
 * Resolves a mock module specifier to the string that the ownership globs
 * match. A relative specifier (`./x`, `../x`) resolves against the directory
 * of the diff file, with `.` and `..` segments normalized. A bare package
 * specifier stays as written, so it is owned only when a first-party glob
 * matches the specifier itself.
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

/** The detection-family words that {@link detectIdentifier} searches for. */
const FAMILY: readonly MockIdentifier[] = ['monkeypatch', 'mock', 'stub', 'spy', 'fake', 'patch'];

function isLowerLetter(ch: string | undefined): boolean {
  return ch !== undefined && ch >= 'a' && ch <= 'z';
}

function isUpperLetter(ch: string | undefined): boolean {
  return ch !== undefined && ch >= 'A' && ch <= 'Z';
}

/**
 * Finds the family identifier with the earliest position at an identifier
 * boundary in `text`. The match is case-insensitive.
 * - Leading boundary: the character before is not a lowercase letter, or the
 *   word starts with an uppercase letter (the `Fake` in `createFake`).
 * - Trailing boundary: the character after is not a lowercase letter. So
 *   `mock(`, `spyOn`, and `monkeypatch.` match, but `stubbornness` and
 *   `spying` do not.
 * The heuristic is not exact. The trailing rule is the main guard against
 * false positives.
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
 * Extracts the mocked module specifier from a mock site: the first quoted
 * string on the line, as in `vi.mock('x')` or `jest.mock("x")`. If the line
 * has no quoted string, it returns the trimmed line, so the finding still
 * names a target.
 */
function extractTarget(text: string): string {
  const match = text.match(/['"]([^'"]+)['"]/);
  return match?.[1] ?? text.trim();
}

/**
 * Finds the mock sites that a diff adds to test files, and returns the ones
 * whose resolved target matches no first-party glob. Files that
 * {@link splitHunks} classifies as source are not scanned. A first-party mock
 * is low risk, so it is not returned.
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
      continue;
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
        continue;
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
