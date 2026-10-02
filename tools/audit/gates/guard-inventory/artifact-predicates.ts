import { default as ts } from 'typescript';

/**
 * True for a backtick span shaped like a repo-relative file path. The `**Files:**`
 * lines also hold directories, slash commands and prose words. A dotted extension,
 * no whitespace, no colon and no leading slash keep those out without a rejection
 * list. A renamed real path still matches, so it shows in `unresolvedSpecArtifacts`.
 */
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

/**
 * True when the module sets an exit status outside any function. That is a
 * `process.exit(…)` call, or a `process.exitCode = …` assignment, which is the
 * same entrypoint without the flush hazard. Such a module runs on load and can
 * fail a build.
 *
 * It parses the source, so a call written in a comment never counts. A source
 * with parse errors throws, because `false` reads as "not a gate".
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
    const isProcessMember = (n: ts.Node, member: string): boolean =>
      ts.isPropertyAccessExpression(n) &&
      n.name.text === member &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'process';

    if (ts.isCallExpression(node) && isProcessMember(node.expression, 'exit') && !insideFunction(node)) {
      found = true;
      return;
    }
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
 * Classifies the entrypoint predicate of a module.
 *
 * A filename test on `argv[1]` is a finding only when its enclosing statement
 * holds no identity check of `argv[1]` against `import.meta.url`. In
 * `path.resolve(entry) === fileURLToPath(import.meta.url) || entry.endsWith('/name.mjs')`
 * the filename arm widens the identity check, so a rename still self-executes.
 * Both operands are followed through variable aliases. A source with parse
 * errors throws, because `[]` reads as "no coupling found".
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
 * Maps each source tree to the tree that holds its suites. The first matching
 * prefix wins, so a specific subtree comes before its catch-all.
 *
 * An artifact whose constructed path finds nothing reports "no self-test", not
 * an error. A stale entry thus silences a whole tree of guards. The test
 * `GuardInventory_EverySelfTestMirror_PairsSomethingReal` asserts that each
 * entry still pairs a real file.
 */
export const SELF_TEST_MIRRORS: readonly (readonly [string, string])[] = Object.freeze([
  ['tools/audit/core/', 'tests/core/scripts/'],
  ['tools/audit/gates/', 'tests/scripts/'],
  ['tools/audit/lib/', 'tests/scripts/lib/'],
  ['tools/audit/tsconfig-strictness/', 'tests/scripts/tsconfig-strictness/'],
  /** The catch-all for the loose files in `tools/audit/`. Their suites keep an `audit/` segment. */
  ['tools/audit/', 'tests/scripts/audit/'],
  ['src/', 'tests/unit/'],
]);

/**
 * Self-test candidates for an artifact, in resolution order: the sibling path,
 * then the mirrored path from {@link SELF_TEST_MIRRORS}. The suites for `src/`
 * live under `tests/unit/`, so without the mirrored path the pairing finds
 * nothing for the product tree.
 */
export function selfTestCandidates(artifact: string): string[] {
  const base = artifact.replace(/\.[cm]?[jt]s$/, '').replace(/\.sh$/, '');
  const bases = [base];
  const mirror = SELF_TEST_MIRRORS.find(([from]) => base.startsWith(from));
  if (mirror) bases.push(`${mirror[1]}${base.slice(mirror[0].length)}`);
  return bases.flatMap((b) => [`${b}.test.ts`, `${b}.test.mts`, `${b}.test.mjs`, `${b}.test.sh`]);
}
