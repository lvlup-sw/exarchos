import { default as ts } from 'typescript';

export function isPathShaped(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith('/') || value.includes(':') || /\s/.test(value)) return false;
  if (value.endsWith('/')) return false;
  return /\.[A-Za-z0-9]+$/.test(value);
}

/** Test-file paths are subjects of the inventory's hosting resolution, never guards themselves. */
export function isTestArtifact(path: string): boolean {
  return /\.(test|type-test|bench|smoke\.test)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)__tests__\//.test(path);
}

// ─── Channel 3: runnable gates with a co-located self-test ───────────────────

/**
 * True iff the module has a STATEMENT-LEVEL `process.exit(…)` — one not nested
 * inside a function body, so it executes on load and can fail a build.
 *
 * A real parse, deliberately: `cli-derivation-guard.ts` records that a naive
 * `/\.command\(/` over the very file it governs reports 15 sites instead of 14
 * because a JSDoc block writes the call in prose. Comments are blanked
 * STRUCTURALLY here for the same reason — the parser classifies them as trivia,
 * so they never become `CallExpression` nodes at all.
 *
 * Fails CLOSED: a source the parser had to recover from throws rather than
 * contributing a `false` that would read as "not a gate".
 */
export function hasDirectRunExit(source: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const diagnostics: unknown = Reflect.get(sourceFile, 'parseDiagnostics');
  if (Array.isArray(diagnostics) && diagnostics.length > 0) {
    throw new Error(`${fileName}: ${diagnostics.length} parse error(s) — refusing to classify`);
  }
  let found = false;
  const insideFunction = (node: ts.Node): boolean => {
    let parent = node.parent;
    while (parent !== undefined) {
      if (
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isConstructorDeclaration(parent)
      ) {
        return true;
      }
      parent = parent.parent;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'exit' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'process' &&
      !insideFunction(node)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Where each source tree's suites were lifted to, longest prefix first so a
 * specific subtree wins over the catch-all.
 *
 * Pairing is by CONSTRUCTED path, and an artifact whose constructed path finds
 * nothing reports as "no self-test" rather than as an error — so a stale entry
 * here takes a whole tree of guards quiet without reddening anything. That is
 * why the mapping is one ordered table rather than a chain of `else if` arms:
 * a relocation is absorbed in one place, and
 * `GuardInventory_EverySelfTestMirror_PairsSomethingReal` asserts every arm
 * still pairs a real file, so an arm that stops resolving fails loudly.
 */
export const SELF_TEST_MIRRORS: readonly (readonly [string, string])[] = Object.freeze([
  ['tools/audit/core/', 'tests/core/scripts/'],
  ['tools/audit/gates/', 'tests/scripts/'],
  ['tools/audit/lib/', 'tests/scripts/lib/'],
  ['tools/audit/tsconfig-strictness/', 'tests/scripts/tsconfig-strictness/'],
  // The catch-all for `tools/audit/`'s own loose files, which task 036 moved
  // from `scripts/audit/` — their suites kept the `audit/` segment.
  ['tools/audit/', 'tests/scripts/audit/'],
  ['src/', 'tests/unit/'],
]);

/**
 * Self-test candidates for an artifact, in resolution order.
 *
 * "Co-located" was literal until task 030 lifted every suite under `src/` into
 * the `tests/unit/` mirror. A module's self-test is still ITS test — only the
 * address changed — so the mirrored path is offered alongside the sibling one.
 * Without this the pairing silently finds nothing for the whole product tree,
 * and channels 3 and 4 stop discovering the censuses they exist to govern.
 */
export function selfTestCandidates(artifact: string): string[] {
  const base = artifact.replace(/\.[cm]?[jt]s$/, '').replace(/\.sh$/, '');
  const bases = [base];
  const mirror = SELF_TEST_MIRRORS.find(([from]) => base.startsWith(from));
  if (mirror) bases.push(`${mirror[1]}${base.slice(mirror[0].length)}`);
  return bases.flatMap((b) => [`${b}.test.ts`, `${b}.test.mts`, `${b}.test.mjs`, `${b}.test.sh`]);
}
