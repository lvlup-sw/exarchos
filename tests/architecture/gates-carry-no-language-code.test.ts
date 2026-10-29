/**
 * No gate source holds a language-specific command, flag, test classifier or toolchain identity.
 *
 * The denominator is derived. It holds the handler module of each gate action and the modules that
 * they import in the gate directories. It also holds each file of `src/verbs/gates` and `src/verbs/pure`,
 * and each config module that a scanned file imports. The registry modules are the allowed home.
 * The guard reads them for the vocabulary only and never scans them.
 *
 * The scan walks the syntax tree of each file and reads its string, template and regex literals.
 * Each literal gets one hit, from the first rule that matches: R1 program, R2 argument, R3 classifier
 * and R4 identity. The live hits must equal `tools/audit/language-code-register.json`, and a later
 * change removes its own rows. The guard proves its population with a planted line, and its matcher
 * with seeded violations and their clean twins.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import { BUILTIN_TOOLCHAINS, testGlobsForToolchain, type Toolchain } from '../../src/config/toolchains.js';
import { LOCKS } from '../../src/config/vendor/package-manager-detector/lockfiles.generated.js';
import { TOOL_REGISTRY } from '../../src/registry.js';
import { TASK_COMPLETION_LEAF_CLASSES } from '../../src/verbs/settle/settlement-reads.js';
import { VERIFICATION_GATE_NAMES } from '../../src/workflow/verification-policy.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** The register of the hits of today. Each row names the owner of its hits and the reason that they exist. */
const REGISTER_FILE = 'tools/audit/language-code-register.json';

/** The module whose `ACTION_HANDLERS` literal maps each action to its handler. */
const COMPOSITE_MODULE = 'src/verbs/composite.ts';

/** The module that holds the task-runner rows of the registry. */
const TASK_RUNNER_MODULE = 'src/config/task-runners.ts';

/** The walk follows a relative import from a scanned file only into these directories. */
const FOLLOWED_ROOTS: readonly string[] = ['src/verbs/gates/', 'src/verbs/pure/', 'src/review/'];

/** The gate directories. The guard scans each non-test file under them. */
const GATE_DIRECTORIES: readonly string[] = ['src/verbs/gates', 'src/verbs/pure'];

/** A scanned file can import a module under this root. The guard scans that module and follows no import out of it. */
const CONFIG_ROOT = 'src/config/';

/**
 * The registry: the allowed home of the facts of each language. The guard never scans these modules.
 * The resolver module and the boundary-adapter module do not exist yet. Later changes add them.
 */
const REGISTRY_MODULES: ReadonlySet<string> = new Set([
  'src/config/toolchains.ts',
  'src/config/task-runners.ts',
  'src/config/test-runtime-resolver.ts',
  'src/config/verification-profile.ts',
  'src/config/boundary-adapters.ts',
]);

/** The vendored lockfile table is part of the registry. */
const REGISTRY_DIRECTORY = 'src/config/vendor/';

/** The phase gates that run repository commands. Each one must be a registered action. */
const COMMAND_PHASE_GATES: readonly string[] = [
  'spec_coverage_check',
  'prepare_synthesis',
  'post_delegation_check',
  'debug_review_gate',
  'check_post_merge',
  'verify_worktree_baseline',
  'pre_synthesis_check',
];

/** The files that the earlier phase-gate guard scanned. This guard replaces it, so each file stays in the denominator. */
const EARLIER_GUARD_FILES: readonly string[] = [
  'src/verbs/team/prepare-synthesis.ts',
  'src/verbs/team/post-delegation-check.ts',
  'src/verbs/review/debug-review-gate.ts',
  'src/verbs/pure/post-merge.ts',
];

/**
 * Programs that no registry row names. The list is a deliberate subset: JavaScript tools, and the
 * mutation and boundary tools that the gates name.
 */
const FIXED_PROGRAMS: readonly string[] = [
  'npx',
  'node',
  'vitest',
  'jest',
  'tsc',
  'eslint',
  'depcruise',
  'semgrep',
  'stryker',
  'pitest',
  'mutmut',
];

/** Source extensions that no registry glob names. The list is a deliberate subset: the common JavaScript and TypeScript extensions. */
const FIXED_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** The programs of the vocabulary that are also English words. Each one is a hit only in a program position. */
const ENGLISH_WORD_PROGRAMS: readonly string[] = ['go', 'make', 'task', 'just', 'mix', 'swift', 'bundle'];

/** The functions that spawn a process. Their first argument is a program position. */
const SPAWN_FUNCTIONS: ReadonlySet<string> = new Set([
  'runCommandSync',
  'runCommand',
  'spawnCommandSync',
  'execFile',
  'execFileSync',
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
]);

/** The spawn functions that take one command string. The first word of that string is the program. */
const COMMAND_STRING_FUNCTIONS: ReadonlySet<string> = new Set(['exec', 'execSync']);

/** A property with one of these names holds a program. */
const PROGRAM_PROPERTIES: ReadonlySet<string> = new Set(['cmd', 'command', 'program', 'bin']);

/** An option: `--` alone, or `-` or `--` before a letter. The option is the whole literal. */
const OPTION_SHAPE = /^(?:--|--?[A-Za-z]\S*)$/;

/** The words that mark a test file in a glob segment. */
const TEST_WORDS: ReadonlySet<string> = new Set(['test', 'tests', 'spec', '__tests__']);

/** A regex source that holds an alternation of two test words, as `(test|spec)` does. */
const TEST_ALTERNATION = /\b(?:test|spec)s?\|(?:test|spec)s?\b/;

/** The text that stands for one substitution of a template literal. It is not whitespace, a word character or `*`. */
const SUBSTITUTION = '\u0001';

/** The rules of the scan, in the order that the scan applies them. */
type Rule = 'R1' | 'R2' | 'R3' | 'R4';

/** The facts that the rules match against. The guard derives each set from the registry and the two fixed lists. */
interface Vocabulary {
  readonly programs: ReadonlySet<string>;
  readonly englishPrograms: ReadonlySet<string>;
  readonly commands: ReadonlySet<string>;
  readonly extensions: ReadonlySet<string>;
  readonly markers: ReadonlySet<string>;
  readonly identities: ReadonlySet<string>;
}

/** One literal that a rule matches. */
interface Hit {
  readonly file: string;
  readonly rule: Rule;
  readonly line: number;
  readonly text: string;
}

/** The scan of one file: how many literals it read, and the hits among them. */
interface FileScan {
  readonly literalCount: number;
  readonly hits: readonly Hit[];
}

/** One row of the register. */
interface RegisterRow {
  readonly file: string;
  readonly rule: Rule;
  readonly count: number;
  readonly owner: string;
  readonly reason: string;
}

/** The handler of one action, as `ACTION_HANDLERS` names it, and the module that holds it. */
interface HandlerEntry {
  readonly handler: string;
  readonly module: string;
}

/** The scanned population. */
interface Denominator {
  readonly actions: ReadonlyMap<string, HandlerEntry | undefined>;
  readonly files: readonly string[];
  readonly configModules: readonly string[];
}

/** The measurement of the live tree that each case reads. */
interface LiveScan {
  readonly vocabulary: Vocabulary;
  readonly denominator: Denominator;
  readonly scans: ReadonlyMap<string, FileScan>;
  readonly register: readonly RegisterRow[];
}

/** The literal text of a string literal or a template literal with no substitution. */
type StringLike = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;

/** Where a literal sits relative to a spawn, for rule R1. */
type Position = 'none' | 'program' | 'command-string';

function readRepoFile(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRule(value: unknown): value is Rule {
  return value === 'R1' || value === 'R2' || value === 'R3' || value === 'R4';
}

function isStringLike(node: ts.Node): node is StringLike {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function isTestFile(rel: string): boolean {
  return /\.(?:test|type-test|bench)\.ts$/.test(rel);
}

function isRegistryModule(rel: string): boolean {
  return REGISTRY_MODULES.has(rel) || rel.startsWith(REGISTRY_DIRECTORY);
}

/** The ids of the task runners, read from the `RUNNERS` table of the registry module. */
function taskRunnerIds(): string[] {
  const ids: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'RUNNERS' &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        for (const property of element.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'id' &&
            isStringLike(property.initializer)
          ) {
            ids.push(property.initializer.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(TASK_RUNNER_MODULE, readRepoFile(TASK_RUNNER_MODULE)));
  return ids;
}

/** The extension of the last segment of a glob, such as `.py` of `test_*.py`. A segment with no extension gives none. */
function extensionOfGlob(glob: string): string | undefined {
  const last = glob.split('/').pop() ?? '';
  const match = /\.([A-Za-z0-9]+)$/.exec(last);
  return match?.[1] === undefined ? undefined : `.${match[1]}`;
}

/**
 * Derives the vocabulary from registry rows. The programs are the first token of each command, the lockfile agents
 * and the task runners. The extensions come from the glob markers and the test globs of each row.
 */
function deriveVocabulary(
  toolchains: readonly Toolchain[],
  agents: readonly string[],
  runners: readonly string[],
  testGlobsOf: (toolchainId: string) => readonly string[] | null,
): Vocabulary {
  const programs = new Set<string>([...FIXED_PROGRAMS, ...agents, ...runners]);
  const commands = new Set<string>();
  const extensions = new Set<string>(FIXED_EXTENSIONS);
  const markers = new Set<string>();
  const identities = new Set<string>();
  for (const toolchain of toolchains) {
    identities.add(toolchain.id);
    identities.add(toolchain.projectType);
    const { test, typecheck, install, mutation, lint, contract } = toolchain.commands;
    for (const command of [test, typecheck, install, mutation, lint, contract?.codegen ?? null, contract?.diff ?? null]) {
      if (command === null) continue;
      commands.add(command);
      const program = command.trim().split(/\s+/)[0];
      if (program !== undefined && program !== '') programs.add(program);
    }
    for (const marker of toolchain.markers) {
      markers.add(marker);
      const extension = marker.includes('*') ? extensionOfGlob(marker) : undefined;
      if (extension !== undefined) extensions.add(extension);
    }
    for (const glob of testGlobsOf(toolchain.id) ?? []) {
      const extension = extensionOfGlob(glob);
      if (extension !== undefined) extensions.add(extension);
    }
  }
  return {
    programs,
    englishPrograms: new Set(ENGLISH_WORD_PROGRAMS.filter((word) => programs.has(word))),
    commands,
    extensions,
    markers,
    identities,
  };
}

function liveVocabulary(): Vocabulary {
  return deriveVocabulary(BUILTIN_TOOLCHAINS, Object.values(LOCKS), taskRunnerIds(), testGlobsForToolchain);
}

function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

/** A git call has a callee whose text holds `git`, or the first argument `'git'`. */
function isGitCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  const text = ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee) ? callee.getText() : '';
  const first = call.arguments[0];
  return /git/i.test(text) || (first !== undefined && isStringLike(first) && first.text === 'git');
}

function isArgumentOf(node: ts.Node, holder: ts.Node): holder is ts.CallExpression {
  return ts.isCallExpression(holder) && holder.arguments.some((argument) => argument === node);
}

/** True when an identifier is an argument of a git call, or a spread in an array argument of one. */
function reachesGitCall(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (isArgumentOf(identifier, parent)) return isGitCall(parent);
  if (ts.isSpreadElement(parent) && ts.isArrayLiteralExpression(parent.parent)) {
    const holder = parent.parent.parent;
    return isArgumentOf(parent.parent, holder) && isGitCall(holder);
  }
  return false;
}

/** True when an identifier reads a binding. A declared name or a property name reads none. */
function isReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name !== identifier;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isBindingElement(parent)
  ) {
    return parent.name !== identifier;
  }
  return true;
}

function referencesNamed(scope: ts.Node, name: string): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && isReference(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/** The block, clause or file that holds the scope of a `const`. */
function scopeOf(node: ts.Node): ts.Node {
  let current = node.parent;
  while (
    !ts.isBlock(current) &&
    !ts.isSourceFile(current) &&
    !ts.isModuleBlock(current) &&
    !ts.isCaseClause(current) &&
    !ts.isDefaultClause(current)
  ) {
    current = current.parent;
  }
  return current;
}

/** True when a local `const` has a reference, and each reference is an argument of a git call. */
function constFeedsOnlyGit(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent;
  if (!ts.isIdentifier(declaration.name) || !ts.isVariableDeclarationList(list)) return false;
  if ((list.flags & ts.NodeFlags.Const) === 0) return false;
  const references = referencesNamed(scopeOf(declaration), declaration.name.text);
  return references.length > 0 && references.every(reachesGitCall);
}

/** The local function of a name: a function declaration, or a `const` that holds an arrow or a function expression. */
function localFunction(file: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | undefined {
  let found: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** True when a call goes to a local function whose body passes the parameter at `index` to a git call. */
function wrapperPassesToGit(call: ts.CallExpression, index: number): boolean {
  if (!ts.isIdentifier(call.expression)) return false;
  const wrapper = localFunction(call.getSourceFile(), call.expression.text);
  const parameter = wrapper?.parameters[index];
  const body = wrapper?.body;
  if (parameter === undefined || body === undefined || !ts.isIdentifier(parameter.name)) return false;
  return referencesNamed(body, parameter.name.text).some(reachesGitCall);
}

/** True when an array literal is a git argv by one of the four forms of the rule. */
function isGitArgvArray(array: ts.ArrayLiteralExpression): boolean {
  const first = array.elements[0];
  if (first !== undefined && isStringLike(first) && first.text === 'git') return true;
  const holder = array.parent;
  if (isArgumentOf(array, holder)) {
    return isGitCall(holder) || wrapperPassesToGit(holder, holder.arguments.findIndex((argument) => argument === array));
  }
  return ts.isVariableDeclaration(holder) && holder.initializer === array && constFeedsOnlyGit(holder);
}

function isInGitArgv(node: ts.Node): boolean {
  const parent = node.parent;
  if (isArgumentOf(node, parent)) return isGitCall(parent);
  return ts.isArrayLiteralExpression(parent) && isGitArgvArray(parent);
}

/** True when a literal is an element of the argv array of a spawn whose program is a literal other than `git`. */
function isLiteralProgramArgvElement(node: ts.Node): boolean {
  const array = node.parent;
  if (!ts.isArrayLiteralExpression(array)) return false;
  const call = array.parent;
  if (!ts.isCallExpression(call) || call.arguments[1] !== array) return false;
  const name = calleeName(call);
  if (!SPAWN_FUNCTIONS.has(name) || COMMAND_STRING_FUNCTIONS.has(name)) return false;
  const program = call.arguments[0];
  return program !== undefined && isStringLike(program) && program.text !== 'git';
}

/**
 * The program position of a literal. The first argument of a spawn function is one, and the value of a program property
 * is one. A string argument that an array-literal argument follows next in the same call is one too.
 */
function positionOf(node: ts.Node): Position {
  const parent = node.parent;
  if (isArgumentOf(node, parent)) {
    const index = parent.arguments.findIndex((argument) => argument === node);
    const name = calleeName(parent);
    if (index === 0 && SPAWN_FUNCTIONS.has(name)) return COMMAND_STRING_FUNCTIONS.has(name) ? 'command-string' : 'program';
    const next = parent.arguments[index + 1];
    if (next !== undefined && ts.isArrayLiteralExpression(next)) return 'program';
  }
  if (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) &&
    PROGRAM_PROPERTIES.has(parent.name.text)
  ) {
    return 'program';
  }
  return 'none';
}

function firstWord(text: string): string {
  return text.trim().split(/\s+/)[0] ?? '';
}

/** R1: a program, a command of the registry, or an English-word program in a program position. */
function matchesProgram(text: string, position: Position, vocabulary: Vocabulary): boolean {
  const word = firstWord(text);
  if (vocabulary.programs.has(word) && !vocabulary.englishPrograms.has(word)) return true;
  if (vocabulary.commands.has(text.trim())) return true;
  if (position === 'command-string') return vocabulary.programs.has(word);
  return position === 'program' && vocabulary.englishPrograms.has(text);
}

function holdsTestWord(segment: string): boolean {
  return segment.includes('__tests__') || segment.split(/[^A-Za-z0-9]+/).some((word) => TEST_WORDS.has(word.toLowerCase()));
}

function endsInExtension(text: string, vocabulary: Vocabulary): boolean {
  return [...vocabulary.extensions].some((extension) => text.endsWith(extension));
}

/**
 * R3 for a string: a glob, an extension, a dotted suffix or a marker. A glob holds `*` and no whitespace,
 * so markdown bold in prose is not a glob.
 */
function matchesClassifier(text: string, vocabulary: Vocabulary): boolean {
  if (text.includes('*') && !/\s/.test(text)) {
    if (endsInExtension(text, vocabulary) || text.split('/').some(holdsTestWord)) return true;
  }
  if (vocabulary.extensions.has(text) || vocabulary.extensions.has(`.${text}`)) return true;
  if (/^\.[^\s/\\]+$/.test(text) && endsInExtension(text, vocabulary)) return true;
  return vocabulary.markers.has(text);
}

/** The runs of word characters in a regex source. An escape pair ends a run and joins none. */
function regexWordRuns(source: string): string[] {
  const runs: string[] = [];
  let current = '';
  for (let index = 0; index < source.length; index++) {
    const char = source.charAt(index);
    if (/\w/.test(char)) {
      current += char;
      continue;
    }
    if (current !== '') runs.push(current);
    current = '';
    if (char === '\\') index++;
  }
  if (current !== '') runs.push(current);
  return runs;
}

/** R3 for a regex: a test-word alternation, or a run that is the stem of a vocabulary extension. */
function regexMatchesClassifier(source: string, vocabulary: Vocabulary): boolean {
  return TEST_ALTERNATION.test(source) || regexWordRuns(source).some((run) => vocabulary.extensions.has(`.${run}`));
}

function classify(node: ts.Node, text: string, vocabulary: Vocabulary): Rule | undefined {
  if (matchesProgram(text, positionOf(node), vocabulary)) return 'R1';
  if (isLiteralProgramArgvElement(node) || (OPTION_SHAPE.test(text) && !isInGitArgv(node))) return 'R2';
  if (matchesClassifier(text, vocabulary)) return 'R3';
  if (vocabulary.identities.has(text)) return 'R4';
  return undefined;
}

/** True for a node whose literals are module specifiers. */
function holdsOnlySpecifiers(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) return true;
  if (ts.isImportTypeNode(node)) return true;
  if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) return true;
  return (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
  );
}

/** Scans the literals of one source file. Comments are not nodes, so the walk never reads them. */
function scanSource(file: string, source: string, vocabulary: Vocabulary): FileScan {
  const sourceFile = parse(file, source);
  let literalCount = 0;
  const hits: Hit[] = [];
  const record = (node: ts.Node, rule: Rule | undefined, text: string): void => {
    literalCount++;
    if (rule === undefined) return;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    hits.push({ file, rule, line, text });
  };
  const visit = (node: ts.Node): void => {
    if (holdsOnlySpecifiers(node)) return;
    if (isStringLike(node)) {
      record(node, classify(node, node.text, vocabulary), node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map((span) => SUBSTITUTION + span.literal.text).join('');
      record(node, classify(node, text, vocabulary), text);
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    if (ts.isRegularExpressionLiteral(node)) {
      const pattern = node.text.slice(1, node.text.lastIndexOf('/'));
      record(node, regexMatchesClassifier(pattern, vocabulary) ? 'R3' : undefined, node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { literalCount, hits };
}

/** Resolves a relative specifier to a repository-relative `.ts` file, or to nothing. */
function resolveSpecifier(fromRel: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.posix.join(path.posix.dirname(fromRel), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, `${base}/index.ts`];
  return candidates.find((candidate) => candidate.endsWith('.ts') && existsSync(path.join(REPO_ROOT, candidate)));
}

/** The relative imports of one file: static imports and exports, and `import()` with a literal specifier. */
function relativeImports(rel: string): string[] {
  const found: string[] = [];
  const add = (specifier: string): void => {
    const target = resolveSpecifier(rel, specifier);
    if (target !== undefined) found.push(target);
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first !== undefined && isStringLike(first)) add(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(rel, readRepoFile(rel)));
  return found;
}

/** The value of an exported string constant of a module, such as the action name that a computed key names. */
function exportedStringConstant(rel: string, name: string): string | undefined {
  for (const statement of parse(rel, readRepoFile(rel)).statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined &&
        isStringLike(declaration.initializer)
      ) {
        return declaration.initializer.text;
      }
    }
  }
  return undefined;
}

/** The handler of each entry of `ACTION_HANDLERS`: the first imported `handle*` name in the entry, and the module of its import. */
function actionHandlers(): Map<string, HandlerEntry | undefined> {
  const sourceFile = parse(COMPOSITE_MODULE, readRepoFile(COMPOSITE_MODULE));
  const importedFrom = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    const target = resolveSpecifier(COMPOSITE_MODULE, statement.moduleSpecifier.text);
    if (bindings === undefined || !ts.isNamedImports(bindings) || target === undefined) continue;
    for (const element of bindings.elements) importedFrom.set(element.name.text, target);
  }
  const actionOf = (name: ts.PropertyName): string | undefined => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    if (!ts.isComputedPropertyName(name) || !ts.isIdentifier(name.expression)) return undefined;
    const module = importedFrom.get(name.expression.text);
    return module === undefined ? undefined : exportedStringConstant(module, name.expression.text);
  };
  const handlerOf = (initializer: ts.Expression): HandlerEntry | undefined => {
    let found: HandlerEntry | undefined;
    const visit = (node: ts.Node): void => {
      const module = ts.isIdentifier(node) ? importedFrom.get(node.text) : undefined;
      if (found === undefined && ts.isIdentifier(node) && node.text.startsWith('handle') && module !== undefined) {
        found = { handler: node.text, module };
      }
      ts.forEachChild(node, visit);
    };
    visit(initializer);
    return found;
  };
  const entries = new Map<string, HandlerEntry | undefined>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ACTION_HANDLERS' &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        const action = ts.isPropertyAssignment(property) ? actionOf(property.name) : undefined;
        if (action !== undefined && ts.isPropertyAssignment(property)) entries.set(action, handlerOf(property.initializer));
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return entries;
}

/** The actions of the registry with `gate` metadata. */
function registryGateActions(): string[] {
  return TOOL_REGISTRY.flatMap((composite) => composite.actions.filter((action) => action.gate !== undefined).map((action) => action.name));
}

/** The gate leaves of the task-completion segment. */
function segmentGateLeaves(): string[] {
  return Object.entries(TASK_COMPLETION_LEAF_CLASSES)
    .filter(([, kind]) => kind === 'gate')
    .map(([leaf]) => leaf);
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listSourceFiles(rel));
    else if (entry.name.endsWith('.ts') && !isTestFile(rel)) files.push(rel);
  }
  return files;
}

/** Derives the scanned population from the registry, `ACTION_HANDLERS` and the imports of the scanned files. */
function deriveDenominator(): Denominator {
  const handlers = actionHandlers();
  const gateActions = new Set([...registryGateActions(), ...VERIFICATION_GATE_NAMES, ...COMMAND_PHASE_GATES, ...segmentGateLeaves()]);
  const actions = new Map<string, HandlerEntry | undefined>();
  for (const action of gateActions) actions.set(action, handlers.get(action));
  const scanned = new Set<string>();
  const queue: string[] = [];
  for (const entry of actions.values()) if (entry !== undefined) queue.push(entry.module);
  queue.push(...GATE_DIRECTORIES.flatMap(listSourceFiles));
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (scanned.has(next)) continue;
    scanned.add(next);
    for (const target of relativeImports(next)) {
      if (FOLLOWED_ROOTS.some((root) => target.startsWith(root)) && !isTestFile(target)) queue.push(target);
    }
  }
  const configModules = new Set<string>();
  for (const rel of scanned) {
    for (const target of relativeImports(rel)) {
      if (target.startsWith(CONFIG_ROOT) && !isRegistryModule(target)) configModules.add(target);
    }
  }
  return {
    actions,
    files: [...scanned, ...configModules].sort(),
    configModules: [...configModules].sort(),
  };
}

function isRegisterRow(value: unknown): value is RegisterRow {
  return (
    isRecord(value) &&
    typeof value['file'] === 'string' &&
    isRule(value['rule']) &&
    typeof value['count'] === 'number' &&
    typeof value['owner'] === 'string' &&
    typeof value['reason'] === 'string'
  );
}

function readRegister(): RegisterRow[] {
  const parsed: unknown = JSON.parse(readRepoFile(REGISTER_FILE));
  const rows: unknown = isRecord(parsed) ? parsed['rows'] : undefined;
  if (!Array.isArray(rows)) throw new Error(`${REGISTER_FILE} holds no "rows" array`);
  const list: readonly unknown[] = rows;
  return list.map((row, index) => {
    if (!isRegisterRow(row)) throw new Error(`${REGISTER_FILE} row ${index} is not { file, rule, count, owner, reason }`);
    return row;
  });
}

/** The count of each file and rule, as `<file> <rule>`. Several rows of one file and rule add up. */
function countsByFileAndRule(entries: Iterable<{ readonly file: string; readonly rule: Rule; readonly count: number }>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.file} ${entry.rule}`;
    counts.set(key, (counts.get(key) ?? 0) + entry.count);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function hitCounts(hits: Iterable<Hit>): Record<string, number> {
  return countsByFileAndRule([...hits].map((hit) => ({ file: hit.file, rule: hit.rule, count: 1 })));
}

function measure(): LiveScan {
  const vocabulary = liveVocabulary();
  const denominator = deriveDenominator();
  const scans = new Map<string, FileScan>();
  for (const file of denominator.files) scans.set(file, scanSource(file, readRepoFile(file), vocabulary));
  return { vocabulary, denominator, scans, register: readRegister() };
}

function ruleAndText(hits: readonly Hit[]): string[] {
  return hits.map((hit) => `${hit.rule} ${hit.text}`);
}

let live: LiveScan | undefined;

/** The live measurement. A case that runs before the hook fails here with a clear message. */
function measured(): LiveScan {
  if (live === undefined) throw new Error('the live scan did not run');
  return live;
}

/** The scan parses each scanned file and the composite module once, so the hook takes the whole budget of the walk. */
beforeAll(() => {
  live = measure();
}, 60_000);

describe('gates carry no language code', () => {
  /** Each gate action maps to an `ACTION_HANDLERS` entry, and its handler resolves to a module that the guard scans. */
  it('LanguageCodeGuard_EveryGateAction_ResolvesToAHandlerModule', () => {
    const { denominator } = measured();
    const unresolved = [...denominator.actions].filter(([, entry]) => entry === undefined).map(([action]) => action);

    expect(registryGateActions().length).toBeGreaterThanOrEqual(28);
    expect(unresolved).toEqual([]);
    for (const [action, entry] of denominator.actions) {
      expect(entry?.module, action).toMatch(/^src\/.+\.ts$/);
      expect(existsSync(path.join(REPO_ROOT, entry?.module ?? '')), `${action} -> ${entry?.module}`).toBe(true);
      expect(denominator.files, `${action} -> ${entry?.module}`).toContain(entry?.module);
    }
  });

  /** The segment gates and the phase gates that run repository commands are in the denominator. The completion leaf is not a gate. */
  it('LanguageCodeGuard_Denominator_HoldsEachSegmentGateAndEachCommandPhaseGate', () => {
    const { denominator } = measured();
    const registered = new Set(TOOL_REGISTRY.flatMap((composite) => composite.actions.map((action) => action.name)));
    const leaves = segmentGateLeaves();

    expect(leaves.length).toBeGreaterThanOrEqual(4);
    expect(TASK_COMPLETION_LEAF_CLASSES.task_complete).toBe('completion');
    for (const action of [...VERIFICATION_GATE_NAMES, ...leaves, ...COMMAND_PHASE_GATES]) {
      expect(registered.has(action), `${action} is not a registered action`).toBe(true);
      expect(denominator.files, action).toContain(denominator.actions.get(action)?.module);
    }
    for (const file of EARLIER_GUARD_FILES) expect(denominator.files).toContain(file);
    expect(denominator.files).not.toContain('src/verbs/tasks/tools.ts');
  });

  /** A separate listing of the gate directories proves that the walk loses no file of them. */
  it('LanguageCodeGuard_Denominator_HoldsEachFileOfTheGateDirectories', () => {
    const { denominator } = measured();
    const gates = readdirSync(path.join(REPO_ROOT, 'src/verbs/gates')).filter((name) => name.endsWith('.ts') && !isTestFile(name));
    const pure = readdirSync(path.join(REPO_ROOT, 'src/verbs/pure')).filter((name) => name.endsWith('.ts') && !isTestFile(name));

    expect(gates.length).toBeGreaterThanOrEqual(40);
    expect(pure.length).toBeGreaterThanOrEqual(11);
    for (const name of gates) expect(denominator.files).toContain(`src/verbs/gates/${name}`);
    for (const name of pure) expect(denominator.files).toContain(`src/verbs/pure/${name}`);
    expect(denominator.files.length).toBeGreaterThanOrEqual(60);
  });

  /** A gate imports a registry module too, so the exclusion of the registry is live and not vacuous. */
  it('LanguageCodeGuard_Denominator_HoldsEachConfigModuleThatAGateImports', () => {
    const { denominator } = measured();
    const importsOfGates = denominator.files.filter((file) => !file.startsWith(CONFIG_ROOT)).flatMap(relativeImports);

    expect(denominator.configModules).toContain('src/config/load-exarchos-config.ts');
    expect(denominator.configModules.length).toBeGreaterThanOrEqual(5);
    expect(importsOfGates).toContain('src/config/toolchains.ts');
    for (const module of denominator.configModules) {
      expect(module.startsWith(CONFIG_ROOT), module).toBe(true);
      expect(isRegistryModule(module), module).toBe(false);
      expect(denominator.files).toContain(module);
    }
    expect(denominator.files.filter(isRegistryModule)).toEqual([]);
  });

  /** A file that gives no literal is a file that the parser did not read. */
  it('LanguageCodeGuard_EachScannedFile_HoldsAStringLiteral', () => {
    const { denominator, scans } = measured();

    expect(scans.size).toBe(denominator.files.length);
    for (const file of denominator.files) {
      expect(scans.get(file)?.literalCount ?? 0, `${file} gave no literal`).toBeGreaterThan(0);
    }
  });

  /** A planted registry row adds its program, its extensions and its identity, so the vocabulary is derived and not fixed. */
  it('LanguageCodeGuard_Vocabulary_DerivesFromTheToolchainRegistry', () => {
    const { vocabulary } = measured();
    const planted: Toolchain = {
      id: 'zig',
      projectType: 'Zig',
      markers: ['build.zig', '*.zon'],
      commands: { test: 'zig build test', typecheck: null, install: null, mutation: null, lint: null, contract: null },
    };
    const plantedGlobs = (id: string): readonly string[] | null => (id === 'zig' ? ['**/*_test.zig'] : testGlobsForToolchain(id));
    const extended = deriveVocabulary([...BUILTIN_TOOLCHAINS, planted], Object.values(LOCKS), taskRunnerIds(), plantedGlobs);

    for (const toolchain of BUILTIN_TOOLCHAINS) {
      expect([...vocabulary.identities]).toContain(toolchain.id);
      const program = firstWord(toolchain.commands.test ?? '');
      if (program !== '') expect([...vocabulary.programs]).toContain(program);
    }
    for (const agent of Object.values(LOCKS)) expect([...vocabulary.programs]).toContain(agent);
    expect(taskRunnerIds()).toEqual(expect.arrayContaining(['task', 'just', 'mise', 'make']));
    expect([...vocabulary.extensions]).toEqual(expect.arrayContaining(['.csproj', '.sln', '.cs', '.py', '.go', '.php']));
    expect([...vocabulary.englishPrograms].sort()).toEqual([...ENGLISH_WORD_PROGRAMS].sort());
    for (const fact of ['zig', '.zon', '.zig', 'build.zig', 'Zig']) {
      const derived = [...extended.programs, ...extended.extensions, ...extended.markers, ...extended.identities];
      expect(derived, fact).toContain(fact);
    }
    expect([...vocabulary.programs, ...vocabulary.extensions]).not.toContain('zig');
  });

  /** A row with a wrong count or a missing row fails here. The message lists the live hits of each file that differs. */
  it('LanguageCodeGuard_LiveHits_EqualTheRegister', () => {
    const { scans, register } = measured();
    const hits = [...scans.values()].flatMap((scan) => scan.hits);
    const liveCounts = hitCounts(hits);
    const registered = countsByFileAndRule(register);
    const differing = new Set(
      [...Object.keys(liveCounts), ...Object.keys(registered)].filter((key) => liveCounts[key] !== registered[key]),
    );
    const detail = hits
      .filter((hit) => differing.has(`${hit.file} ${hit.rule}`))
      .map((hit) => `${hit.file}:${hit.line} ${hit.rule} ${JSON.stringify(hit.text)}`);

    expect(liveCounts, detail.join('\n')).toEqual(registered);
  });

  /** Each row names a file of the denominator, a rule, a positive count, an owner and a reason. */
  it('LanguageCodeGuard_EachRegisterRow_NamesAnOwnerAndAReason', () => {
    const { denominator, register } = measured();
    const keys = register.map((row) => `${row.file} ${row.rule} ${row.reason}`);

    expect(register.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    for (const row of register) {
      expect(denominator.files, row.file).toContain(row.file);
      expect(Number.isInteger(row.count) && row.count > 0, `${row.file} ${row.rule} count`).toBe(true);
      expect(row.owner, `${row.file} ${row.rule} owner`).toMatch(/^(?:#\d+|self-scan)$/);
      expect(row.reason.trim().length, `${row.file} ${row.rule} reason`).toBeGreaterThan(20);
    }
  });

  /** The planted spawn adds one program hit and four argument hits to a live gate file, and the register then differs. */
  it('LanguageCodeGuard_APlantedLineInALiveGateFile_IsFound', () => {
    const { vocabulary, scans, register } = measured();
    const file = 'src/verbs/gates/static-analysis.ts';
    const text = readRepoFile(file);
    const plantedLine = text.split('\n').length + 1;
    const planted = scanSource(file, `${text}\nrunCommandSync('cargo', ['clippy', '--', '-D', 'warnings']);\n`, vocabulary);
    const others = [...scans].filter(([name]) => name !== file).flatMap(([, scan]) => scan.hits);

    expect(ruleAndText(planted.hits.filter((hit) => hit.line === plantedLine))).toEqual([
      'R1 cargo',
      'R2 clippy',
      'R2 --',
      'R2 -D',
      'R2 warnings',
    ]);
    expect(planted.hits.length).toBe((scans.get(file)?.hits.length ?? 0) + 5);
    expect(hitCounts([...others, ...planted.hits])).not.toEqual(countsByFileAndRule(register));
  });

  /** Each seeded line gives exactly the hits that the rules name for it, in source order. */
  it('LanguageCodeGuard_Matcher_FindsEachSeededViolation', () => {
    const seeded = [
      "runCommandSync('dotnet', ['build', '--no-restore', '-warnaserror'], { cwd: repoRoot });",
      "execSync('npx vitest run --root ' + repoRoot);",
      "runCommandSync('go', ['vet', './...']);",
      "runGenericCheck('Vet', 'go', ['vet', './...']);",
      "runCommandSync(bin, [...rest, '--', ...testFiles]);",
      "[...parts, '--reporter=json'];",
      "runCommandSync(bin, ['--reporter=json']);",
      "args.push('-D', 'warnings');",
      "const FLAGS = ['--no-restore'];",
      'const TEST_PATH = /\\.(test|spec)\\.[cm]?[jt]sx?$/i;',
      "['**/*Tests.cs', '**/*.test.*'];",
      "file.endsWith('.py');",
      "name.endsWith('.test.ts');",
      "['cs', 'go', 'py'];",
      "readFileSync(path.join(root, 'package.json'));",
      "if (toolchain.id === 'python') {}",
      "label === '.NET';",
    ].join('\n');

    expect(ruleAndText(scanSource('seeded.ts', seeded, measured().vocabulary).hits)).toEqual([
      'R1 dotnet',
      'R2 build',
      'R2 --no-restore',
      'R2 -warnaserror',
      'R1 npx vitest run --root ',
      'R1 go',
      'R2 vet',
      'R2 ./...',
      'R1 go',
      'R2 --',
      'R2 --reporter=json',
      'R2 --reporter=json',
      'R2 -D',
      'R2 --no-restore',
      'R3 /\\.(test|spec)\\.[cm]?[jt]sx?$/i',
      'R3 **/*Tests.cs',
      'R3 **/*.test.*',
      'R3 .py',
      'R3 .test.ts',
      'R3 cs',
      'R3 go',
      'R3 py',
      'R3 package.json',
      'R4 python',
      'R4 .NET',
    ]);
  });

  /** The twin of the seeded case. The scan reads each literal of these lines, and none is a hit. */
  it('LanguageCodeGuard_Matcher_IgnoresCommentsImportsGitArgvAndProse', () => {
    const clean = [
      '// The old gate ran npm run test:run here, with -warnaserror.',
      "import { splitHunks } from './test-adequacy.js';",
      "const loaded = await import('./static-analysis.js');",
      'runCommandSync(argv[0], probeArgv(form, argv, files));',
      "gitExec(repoRoot, ['diff', '-z', '--no-renames', range]);",
      "execFileSync('git', ['checkout', base, '--', ...files]);",
      "execFileSync('git', ['-C', worktreePath, ...gitArgs]);",
      "const args = ['diff', '--name-only', ...spec.split(' ')];",
      "execFileSync('git', args, { cwd: repoRoot });",
      'const safe = (argv: readonly string[]) => gitExec(repoRoot, argv);',
      "safe(['--version']);",
      "const mergeBase = ['git', 'merge-base', '--is-ancestor', target, source];",
      "const subject = { kind: 'task', taskId };",
      "if (subject.kind === 'task') {}",
      "const notes = ['npm-run-all is a different program', 'make sure that the task worktree is clean', 'verbs/gates/gate-runner.ts'];",
      "const scope = ['src/**', 'servers/*/src/**'];",
      "const docs = { docGlobs: ['docs/**', '**/*.md'] };",
      "const report = '**Result: PASS** (3 tests, no load failures)';",
    ].join('\n');

    const result = scanSource('clean.ts', clean, measured().vocabulary);

    expect(ruleAndText(result.hits)).toEqual([]);
    expect(result.literalCount).toBe(26);
  });
});
