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
    /** `process.exit` / `process.exitCode`, as a property access off `process`. */
    const isProcessMember = (n: ts.Node, member: string): boolean =>
      ts.isPropertyAccessExpression(n) &&
      n.name.text === member &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'process';

    if (ts.isCallExpression(node) && isProcessMember(node.expression, 'exit') && !insideFunction(node)) {
      found = true;
      return;
    }
    // `process.exitCode = runGuard()` is the same entrypoint with the flush
    // hazard removed, so it has to classify the same way.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isProcessMember(node.left, 'exitCode') &&
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

/** A guard whose self-execution is decided by its own filename. */
export interface FilenameCoupledEntrypoint {
  readonly artifact: string;
  /** The filename literals the predicate tests, in source order. */
  readonly literals: readonly string[];
}

export interface EntrypointPredicate {
  /** Filename literals `argv[1]` is tested against with no identity check alongside. */
  readonly coupledLiterals: readonly string[];
}

/**
 * Classify a module's entrypoint predicate.
 *
 * A filename test is only a FINDING when nothing in the same statement also
 * compares `argv[1]` against `import.meta.url`. That distinction is load-bearing:
 * several gates read
 *
 *     path.resolve(entry) === fileURLToPath(import.meta.url) || entry.endsWith('/name.mjs')
 *
 * where the filename arm WIDENS an identity check rather than replacing it — a
 * rename still self-executes through the first disjunct. Scoping to the nearest
 * enclosing STATEMENT is what separates them from a bare
 * `process.argv[1].endsWith('cli-vocab-guard.ts')`.
 *
 * Both operands are followed through single-assignment aliases (`const entry =
 * process.argv[1]`, `const self = fileURLToPath(import.meta.url)`).
 *
 * Fails CLOSED on a source the parser had to recover from — a `[]` there would
 * read as "no coupling found".
 */
export function classifyEntrypointPredicate(source: string, fileName: string): EntrypointPredicate {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const diagnostics: unknown = Reflect.get(sourceFile, 'parseDiagnostics');
  if (Array.isArray(diagnostics) && diagnostics.length > 0) {
    throw new Error(`${fileName}: ${diagnostics.length} parse error(s) — refusing to classify`);
  }

  const subtreeHas = (node: ts.Node, pred: (n: ts.Node) => boolean): boolean => {
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (pred(n)) {
        found = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  const isArgv1 = (n: ts.Node): boolean =>
    ts.isElementAccessExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === 'argv' &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === 'process' &&
    ts.isNumericLiteral(n.argumentExpression) &&
    n.argumentExpression.text === '1';

  const isImportMeta = (n: ts.Node): boolean => n.kind === ts.SyntaxKind.MetaProperty;

  const argvAliases = new Set<string>();
  const metaAliases = new Set<string>();
  const collectAliases = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      if (subtreeHas(n.initializer, isArgv1)) argvAliases.add(n.name.text);
      if (subtreeHas(n.initializer, isImportMeta)) metaAliases.add(n.name.text);
    }
    ts.forEachChild(n, collectAliases);
  };
  ts.forEachChild(sourceFile, collectAliases);

  const mentionsArgv = (n: ts.Node): boolean =>
    subtreeHas(n, (x) => isArgv1(x) || (ts.isIdentifier(x) && argvAliases.has(x.text)));
  const mentionsMeta = (n: ts.Node): boolean =>
    subtreeHas(n, (x) => isImportMeta(x) || (ts.isIdentifier(x) && metaAliases.has(x.text)));

  const enclosingStatement = (node: ts.Node): ts.Node => {
    let current: ts.Node = node;
    while (current.parent !== undefined && !ts.isStatement(current)) current = current.parent;
    return current;
  };

  const isIdentityCheck = (n: ts.Node): boolean => {
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      return (
        (mentionsArgv(n.left) && mentionsMeta(n.right)) ||
        (mentionsArgv(n.right) && mentionsMeta(n.left))
      );
    }
    if (ts.isCallExpression(n)) {
      return n.arguments.some((a) => mentionsArgv(a)) && n.arguments.some((a) => mentionsMeta(a));
    }
    return false;
  };

  const coupledLiterals: string[] = [];
  const isFilenameTest = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    (n.expression.name.text === 'endsWith' || n.expression.name.text === 'includes') &&
    n.arguments.length === 1 &&
    mentionsArgv(n.expression.expression);

  const visit = (n: ts.Node): void => {
    if (isFilenameTest(n)) {
      const literal = n.arguments[0];
      if (
        literal !== undefined &&
        ts.isStringLiteralLike(literal) &&
        !subtreeHas(enclosingStatement(n), isIdentityCheck)
      ) {
        coupledLiterals.push(literal.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return { coupledLiterals };
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
