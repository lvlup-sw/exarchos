// Every rename in src/ that replaces a file goes through src/utils/atomic-write.ts.
// That module queues the renames to one path, so two of our own writers cannot
// collide on Windows. This guard parses each source file under src/ and finds
// each use of `rename` or `renameSync`. A use is a property or element access,
// an import or export specifier, or a destructured name. Only the primitive and
// a named exemption can hold a use, and each exemption pins its count.
//
// The guard counts a seam binding such as `rename: (from, to) => fs.rename(from, to)`
// and allows it. The binding only passes the capability on, and each call
// through the seam is itself a use. The guard asserts a lower bound on the files
// that it parses, and it proves its matcher on seeded violations and a clean twin.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** The one module that can rename a file over its target. */
const PRIMITIVE = 'src/utils/atomic-write.ts';

/** The member and export names of `node:fs` that rename a path. */
const RENAME_NAMES: ReadonlySet<string> = new Set(['rename', 'renameSync']);

/** Source files the guard parses. */
const SOURCE_FILE = /\.[cm]?[jt]s$/;

/** Lower bound on the files under src/. A wrong root parses far fewer. */
const MIN_SOURCE_FILES = 700;

/** Lower bound on seam bindings in src/. A count of zero means that the binding matcher is dead. */
const MIN_SEAM_BINDINGS = 9;

interface Exemption {
  /** Why these renames are not a file replace that the primitive must own. */
  readonly reason: string;
  /** The exact number of uses granted. A change in either direction fails. */
  readonly uses: number;
}

/** Renames that move a path rather than publish a staged file over a target. */
const EXEMPTIONS: Readonly<Record<string, Exemption>> = {
  'src/storage/sidecar-scheduler.ts': {
    reason:
      'Claims a sidecar by moving it to a drain path that is unique to this drainer, and ' +
      'moves it back when the drain file cannot be read. Neither rename publishes a staged ' +
      'temp file over a target that another writer also replaces.',
    uses: 2,
  },
  'src/install/operations/symlink.ts': {
    reason:
      'Moves an existing directory aside to a unique, timestamped backup path before it ' +
      'creates a link. It is a directory move, not a file replace.',
    uses: 1,
  },
  'src/install/atomic-promotion.ts': {
    reason:
      'The tree promotion engine renames whole directories through its injected seam. Its ' +
      'default seam already publishes through publishTempFileSync.',
    uses: 1,
  },
};

type UseForm = 'access' | 'element' | 'import' | 'export' | 'destructure';

interface RenameUse {
  readonly line: number;
  readonly form: UseForm;
  readonly text: string;
}

interface RenameScan {
  readonly uses: readonly RenameUse[];
  readonly bindings: number;
}

/** A property assignment whose key is `rename` or `renameSync`. */
function isRenameProperty(node: ts.Node): node is ts.PropertyAssignment {
  return (
    ts.isPropertyAssignment(node) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
    RENAME_NAMES.has(node.name.text)
  );
}

/** `true` when `call` passes the arrow's own parameters through, in order and unchanged. */
function forwardsParameters(arrow: ts.ArrowFunction, call: ts.CallExpression): boolean {
  const names = arrow.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : undefined));
  return (
    names.length > 0 &&
    call.arguments.length === names.length &&
    call.arguments.every((arg, i) => ts.isIdentifier(arg) && arg.text === names[i])
  );
}

/**
 * A seam binding: `rename: fs.renameSync`, or `rename: (from, to) => x.rename(from, to)`.
 * The property must keep a rename name and the arrow must only forward its
 * parameters, so a binding cannot hide a call with fixed paths.
 */
function isSeamBinding(access: ts.PropertyAccessExpression): boolean {
  const parent = access.parent;
  if (isRenameProperty(parent)) return parent.initializer === access;
  if (!ts.isCallExpression(parent) || parent.expression !== access) return false;
  const arrow = parent.parent;
  if (!ts.isArrowFunction(arrow) || arrow.body !== parent) return false;
  return isRenameProperty(arrow.parent) && forwardsParameters(arrow, parent);
}

/** The key a destructured name reads, when it is a plain name. */
function destructuredKey(node: ts.BindingElement): string | undefined {
  const key = node.propertyName ?? node.name;
  return ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
}

/** Every use of `rename` or `renameSync` in `source`, and the number of seam bindings. */
function scanRenameUses(fileName: string, source: string): RenameScan {
  const kind = /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const uses: RenameUse[] = [];
  let bindings = 0;
  const record = (node: ts.Node, form: UseForm): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    uses.push({ line: line + 1, form, text: node.getText(sourceFile) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && RENAME_NAMES.has(node.name.text)) {
      if (isSeamBinding(node)) bindings++;
      else record(node, 'access');
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      RENAME_NAMES.has(node.argumentExpression.text)
    ) {
      record(node, 'element');
    } else if (ts.isImportSpecifier(node) && RENAME_NAMES.has((node.propertyName ?? node.name).text)) {
      record(node, 'import');
    } else if (ts.isExportSpecifier(node) && RENAME_NAMES.has((node.propertyName ?? node.name).text)) {
      record(node, 'export');
    } else if (ts.isBindingElement(node) && RENAME_NAMES.has(destructuredKey(node) ?? '')) {
      record(node, 'destructure');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { uses, bindings };
}

/** Scan every source file under src/, keyed by repo-relative POSIX path. */
function scanSourceTree(): Map<string, RenameScan> {
  const scans = new Map<string, RenameScan>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
        const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
        scans.set(rel, scanRenameUses(rel, readFileSync(abs, 'utf8')));
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  return scans;
}

describe('atomic replace owns every rename in src/', () => {
  const scans = scanSourceTree();

  /**
   * A guard that parses nothing finds no offender. This test asserts the
   * denominators: the file count, the seam bindings, and the known sites.
   */
  it('AtomicReplaceGuard_ParsesTheSourceTreeAndFindsItsKnownSites', () => {
    const bindings = [...scans.values()].reduce((sum, scan) => sum + scan.bindings, 0);

    expect(scans.size).toBeGreaterThanOrEqual(MIN_SOURCE_FILES);
    expect(bindings).toBeGreaterThanOrEqual(MIN_SEAM_BINDINGS);
    expect(scans.get(PRIMITIVE)?.uses.length ?? 0).toBeGreaterThan(0);
    for (const rel of Object.keys(EXEMPTIONS)) {
      expect(scans.has(rel), `exempt file ${rel} is missing`).toBe(true);
    }
  });

  it('AtomicReplaceGuard_NoRenameOutsideThePrimitiveAndItsExemptions', () => {
    const offenders = Object.fromEntries(
      [...scans]
        .filter(([rel, scan]) => rel !== PRIMITIVE && !(rel in EXEMPTIONS) && scan.uses.length > 0)
        .map(([rel, scan]) => [rel, scan.uses.map((use) => `${use.line}: ${use.text}`)]),
    );

    expect(offenders).toEqual({});
  });

  /** A new rename in an exempt file must be argued, and a removed one must shrink the pin. */
  it('AtomicReplaceGuard_EachExemptionMatchesItsPinnedCount', () => {
    const actual = Object.fromEntries(
      Object.keys(EXEMPTIONS).map((rel) => [rel, scans.get(rel)?.uses.length ?? 0]),
    );
    const pinned = Object.fromEntries(
      Object.entries(EXEMPTIONS).map(([rel, exemption]) => [rel, exemption.uses]),
    );

    expect(actual).toEqual(pinned);
  });

  /** One seeded line per form a raw rename can take, including a binding that hides fixed paths. */
  it('AtomicReplaceGuard_Matcher_FindsSeededViolations', () => {
    const seeded = [
      "import { rename } from 'node:fs/promises';",
      "import { renameSync as move } from 'node:fs';",
      "export { rename } from 'node:fs/promises';",
      'fs.renameSync(tmp, target);',
      'await fs.promises.rename(tmp, target);',
      'await fsp.rename(tmp, target);',
      "fs['renameSync'](tmp, target);",
      'const { rename: aliased } = fsp;',
      'const { promises: { rename: nested } } = fs;',
      'io.renameSync(tmp, target);',
      'const fixed = { rename: () => fs.rename(tmp, target) };',
      'const hidden = { move: (from, to) => fs.rename(from, to) };',
      'const loose = fs.renameSync;',
    ].join('\n');

    const result = scanRenameUses('seeded.ts', seeded);

    expect(result.uses.map((use) => [use.line, use.form])).toEqual([
      [1, 'import'],
      [2, 'import'],
      [3, 'export'],
      [4, 'access'],
      [5, 'access'],
      [6, 'access'],
      [7, 'element'],
      [8, 'destructure'],
      [9, 'destructure'],
      [10, 'access'],
      [11, 'access'],
      [12, 'access'],
      [13, 'access'],
    ]);
    expect(result.bindings).toBe(0);
  });

  /** The twin: comments, strings, seam signatures and pure forwarding bindings are not uses. */
  it('AtomicReplaceGuard_Matcher_IgnoresSeamBindingsAndTheCleanTwin', () => {
    const clean = [
      '// fs.renameSync(tmp, target) was the old publish.',
      "const label = 'fs.rename';",
      'interface Seam { rename(from: string, to: string): Promise<void>; renameSync?(a: string, b: string): void }',
      'const seam = { rename: (from, to) => nodeFs.rename(from, to) };',
      'const syncSeam = { renameSync: fs.renameSync };',
      'const crossed = { rename: (from, to) => io.renameSync(from, to) };',
      'await publishTempFile(tmp, target, { rename: (from, to) => deps.fs.rename(from, to) });',
      'await atomicReplace(target, data);',
    ].join('\n');

    const result = scanRenameUses('clean.ts', clean);

    expect(result.uses).toEqual([]);
    expect(result.bindings).toBe(4);
  });
});
