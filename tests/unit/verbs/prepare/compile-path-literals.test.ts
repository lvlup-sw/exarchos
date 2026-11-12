/**
 * No module of the compile path of `prepare` names a built-in workflow type or step as a literal.
 *
 * The scan parses each `.ts` module under `src/verbs/prepare` with the TypeScript parser. It refuses a string literal
 * or a template part whose whole text is one of the two literals of this file. It also refuses the two names of the
 * retired switch constants. This file builds each name from two parts, so no file of the tree holds a name whole.
 * The denominator of scanned modules and a literal that each case seeds in memory prove that the scan can fail.
 *
 * @oracle-sources: the TypeScript syntax tree of each module of src/verbs/prepare, the two literals of this file and the two names that it builds from two parts
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/** The directory of the prepare verb. */
const PREPARE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../src/verbs/prepare');

/** The fewest modules that the scan reads. A walk that finds fewer is broken. */
const MIN_SCANNED_MODULES = 15;

/** The whole literals that no module of the compile path holds: one built-in workflow type and one built-in step. */
const FORBIDDEN_LITERALS: ReadonlySet<string> = new Set(['feature', 'delegate']);

/** The names of the two retired switch constants, each built from two parts. */
const RETIRED_NAMES: readonly string[] = [
  ['PREPARABLE', 'WORKFLOW_TYPE'].join('_'),
  ['DELEGATION', 'STEP_ID'].join('_'),
];

/** One module of the scan, by its path from the repository root and its source text. */
interface ScannedModule {
  readonly module: string;
  readonly source: string;
}

/** Each source module under a directory, recursively, in sorted order. A test module is not a source module. */
function sourceModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceModules(full));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out.sort();
}

/** The modules of the compile path, each with its source text. */
function compilePathModules(): ScannedModule[] {
  return sourceModules(PREPARE_ROOT).map((file) => ({
    module: `src/verbs/prepare/${path.relative(PREPARE_ROOT, file).split(path.sep).join('/')}`,
    source: readFileSync(file, 'utf8'),
  }));
}

/** The text of a string literal or of a template part, or `undefined` for each other node. */
function literalTextOf(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return undefined;
}

/** Each forbidden whole literal of one module, as `<module>: <literal>`, in source order. */
function forbiddenLiteralsOf(scanned: ScannedModule): string[] {
  const file = ts.createSourceFile(scanned.module, scanned.source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const text = literalTextOf(node);
    if (text !== undefined && FORBIDDEN_LITERALS.has(text)) found.push(`${scanned.module}: ${text}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Each retired name that one module holds as a whole word, as `<module>: <name>`. */
function retiredNamesOf(scanned: ScannedModule): string[] {
  return RETIRED_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(scanned.source)).map(
    (name) => `${scanned.module}: ${name}`,
  );
}

describe('the compile path of prepare holds no built-in type or step literal', () => {
  it('CompilePath_NoPrepareModule_HoldsAFeatureOrDelegateLiteral', () => {
    const modules = compilePathModules();
    expect(modules.length).toBeGreaterThanOrEqual(MIN_SCANNED_MODULES);
    expect(modules.map((scanned) => scanned.module)).toContain('src/verbs/prepare/handler.ts');

    const handler = modules.find((scanned) => scanned.module === 'src/verbs/prepare/handler.ts');
    if (handler === undefined) throw new Error('the scan found no handler module');
    const seeded: ScannedModule = {
      module: handler.module,
      source: `${handler.source}\nexport const seededType = 'feature';\nexport const seededStep = \`delegate\`;\n`,
    };
    expect(forbiddenLiteralsOf(seeded)).toStrictEqual([
      'src/verbs/prepare/handler.ts: feature',
      'src/verbs/prepare/handler.ts: delegate',
    ]);

    expect(modules.flatMap(forbiddenLiteralsOf)).toStrictEqual([]);
  });

  it('CompilePath_NoPrepareModule_NamesTheRetiredSwitchConstants', () => {
    const modules = compilePathModules();
    expect(modules.length).toBeGreaterThanOrEqual(MIN_SCANNED_MODULES);

    const [typeName, stepName] = RETIRED_NAMES;
    const seeded: ScannedModule = {
      module: 'src/verbs/prepare/handler.ts',
      source: `const ${typeName} = 1;\nconst ${stepName} = 2;\n`,
    };
    expect(retiredNamesOf(seeded)).toStrictEqual([
      `src/verbs/prepare/handler.ts: ${typeName}`,
      `src/verbs/prepare/handler.ts: ${stepName}`,
    ]);

    expect(modules.flatMap(retiredNamesOf)).toStrictEqual([]);
  });
});
