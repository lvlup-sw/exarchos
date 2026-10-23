/**
 * A census of the stream reads that decide a settlement verdict.
 *
 * The scope is each function of the settle handler, and `handleTaskComplete` with each helper of its module that it reaches.
 * The event-reader scanner reports each query and each event-type test. A walk of the syntax tree reports each call
 * of a closed list of read helpers, and each query call. Thus the two finders check each other on the queries.
 * Each read has one role in the table of this file, keyed by its function and by its event type or helper name.
 * A read with no role fails by name, and a role that matches no read fails too.
 *
 * @oracle-sources: ../../src/verbs/settle/handler.ts, ../../src/verbs/tasks/tools.ts, the role of each read written by hand in this file
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { EXECUTION_SETTLED_SETTLEMENT } from '../../src/events/bundle/digest-references.js';
import { DESIGN_REVISED_TYPE } from '../../src/verbs/prepare/design-version.js';
import { WORKFLOW_PREPARED_TYPE } from '../../src/verbs/prepare/prepared-record.js';
import { scanEventReaders } from '../../tools/test-helpers/event-reader-scanner.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HANDLER = 'src/verbs/settle/handler.ts';
const TOOLS = 'src/verbs/tasks/tools.ts';
/** The function of the completion module from which the census walks to the helpers that it reaches. */
const COMPLETION_ROOT = 'handleTaskComplete';

/** The read helpers of the closed list. A call of one of them is a read, whatever its receiver. */
const READ_HELPERS: ReadonlySet<string> = new Set([
  'findPreparedCapsule',
  'readGateEvidenceRecords',
  'resolveWorkflowState',
  'lookupOperationClaim',
  'readStream',
  'tailSequence',
]);

/** The query methods of the event store. The scanner reports each call of them, and so does the syntax walk. */
const QUERY_METHODS: ReadonlySet<string> = new Set(['query', 'queryByType']);

/** The dotted constants that a scanned module names an event type by. */
const KNOWN_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ['EXECUTION_SETTLED_SETTLEMENT.type', EXECUTION_SETTLED_SETTLEMENT.type],
]);

/**
 * The imported constants that a query filter names an event type by. The scanner resolves only the constants of
 * its own module, so the census reads the value of these from the modules that export them.
 */
const IMPORTED_EVENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['WORKFLOW_PREPARED_TYPE', WORKFLOW_PREPARED_TYPE],
  ['DESIGN_REVISED_TYPE', DESIGN_REVISED_TYPE],
]);

/** The helpers that `handleTaskComplete` reaches today. The derived scope holds at least these. */
const COMPLETION_HELPERS: readonly string[] = [
  'attemptTaskComplete',
  'completionStanding',
  'storedCompletion',
  'failedAfterCompletion',
  'repairStoredCompletion',
  'revisionRefusal',
  'gateRefusal',
  'staticAnalysisPrerequisite',
  'runnerSignals',
];

/** The owner of the plan standing, which stays a read before the commit. */
const PLAN_STANDING_OWNER = 'drift row completion-gate-row';

/**
 * The role of one read.
 *
 * `in-commit` is folded again inside the commit. `occ-pinned` is read after the pinned tail of `task_complete`.
 * `immutable` is a record that does not change after its commit. `not-a-verdict-read` decides no verdict.
 * `pre-read` is read before the commit only, and it names its owner.
 */
type ReadRole = 'in-commit' | 'occ-pinned' | 'immutable' | 'not-a-verdict-read' | 'pre-read';

/** One entry of the role table. `read` is `event:<type>`, `event:*` for the whole stream, or `helper:<name>`. */
interface RoleEntry {
  readonly file: string;
  readonly fn: string;
  readonly read: string;
  readonly role: ReadRole;
  readonly reason: string;
  readonly owner?: string;
}

/** The role of each read in scope. A key is the file, the function and the read, never a line. */
const ROLES: readonly RoleEntry[] = [
  {
    file: HANDLER,
    fn: 'heldBatch',
    read: `event:${EXECUTION_SETTLED_SETTLEMENT.type}`,
    role: 'immutable',
    reason: 'the record of the round that held the batch, which no later call changes',
  },
  {
    file: HANDLER,
    fn: 'planStandingLookup',
    read: 'helper:resolveWorkflowState',
    role: 'pre-read',
    reason: 'the plan half of the standing of the named tasks. The commit does not compare it',
    owner: PLAN_STANDING_OWNER,
  },
  {
    file: HANDLER,
    fn: 'traceQualifiersOf',
    read: 'event:gate.executed',
    role: 'not-a-verdict-read',
    reason: 'the marks of the gate rows of a segment, which qualify its trace and decide no verdict',
  },
  {
    file: HANDLER,
    fn: 'replayCommittedSegments',
    read: 'helper:lookupOperationClaim',
    role: 'immutable',
    reason: 'the segment claim of a task, which does not change after its commit',
  },
  {
    file: HANDLER,
    fn: 'readAndJudge',
    read: 'event:*',
    role: 'in-commit',
    reason: 'the whole stream, which the commit folds again from the rows of its write transaction',
  },
  {
    file: HANDLER,
    fn: 'commitJudgement',
    read: 'helper:readStream',
    role: 'in-commit',
    reason: 'the rows of the write transaction, from which the commit judges the batch again',
  },
  {
    file: HANDLER,
    fn: 'handleSettle',
    read: 'helper:findPreparedCapsule',
    role: 'immutable',
    reason: 'the prepared record that pins the capsule, which prepare does not record twice for one version',
  },
  {
    file: HANDLER,
    fn: 'handleSettle',
    read: 'helper:lookupOperationClaim',
    role: 'immutable',
    reason: 'the settlement claim of the batch, which does not change after its commit',
  },
  {
    file: HANDLER,
    fn: 'handleSettle',
    read: 'event:task.completed',
    role: 'not-a-verdict-read',
    reason: 'the replay of a recorded verdict levels the state document from it and decides no verdict',
  },
  {
    file: TOOLS,
    fn: 'completionStanding',
    read: 'helper:tailSequence',
    role: 'occ-pinned',
    reason: 'the tail that the append of the completion pins',
  },
  {
    file: TOOLS,
    fn: 'storedCompletion',
    read: 'event:task.completed',
    role: 'occ-pinned',
    reason: 'the stored completion, read after the pin',
  },
  {
    file: TOOLS,
    fn: 'failedAfterCompletion',
    read: 'event:task.failed',
    role: 'occ-pinned',
    reason: 'a failure that reopens the stored completion, read after the pin',
  },
  {
    file: TOOLS,
    fn: 'revisionRefusal',
    read: `event:${WORKFLOW_PREPARED_TYPE}`,
    role: 'occ-pinned',
    reason: 'the prepared record that is the reference of the revision check, read after the pin',
  },
  {
    file: TOOLS,
    fn: 'revisionRefusal',
    read: `event:${DESIGN_REVISED_TYPE}`,
    role: 'occ-pinned',
    reason: 'the revisions after the reference, read after the pin',
  },
  {
    file: TOOLS,
    fn: 'runnerSignals',
    read: 'event:gate.executed',
    role: 'occ-pinned',
    reason: 'the runner signals of the static-analysis gate, read after the pin',
  },
  {
    file: TOOLS,
    fn: 'staticAnalysisPrerequisite',
    read: 'helper:readGateEvidenceRecords',
    role: 'occ-pinned',
    reason: 'the gate evidence records of the task, read after the pin',
  },
];

/** Which units of a module the census reads: each one, or the units that one function reaches. */
type CensusScope = { readonly kind: 'every-function' } | { readonly kind: 'reached-from'; readonly root: string };

/** One scanned module: the repo path that names it in a role key, the file that holds its source, and its scope. */
interface CensusFile {
  readonly label: string;
  readonly path: string;
  readonly scope: CensusScope;
}

/** One read in scope: its module, its function, what it reads, where it is and the finder that reported it. */
interface FoundRead {
  readonly file: string;
  readonly fn: string;
  readonly read: string;
  readonly line: number;
  readonly finder: 'event-reader scanner' | 'syntax walk';
}

/** What one run of the census found. */
interface Census {
  readonly files: readonly string[];
  readonly scopes: ReadonlyMap<string, readonly string[]>;
  readonly functions: ReadonlyMap<string, readonly string[]>;
  readonly reads: readonly FoundRead[];
  readonly mismatches: readonly string[];
}

/** One declaration at the top level of a module, with the lines that it spans. */
interface ModuleUnit {
  readonly name: string;
  readonly node: ts.Node;
  readonly isFunction: boolean;
  readonly start: number;
  readonly end: number;
}

/** One call that the syntax walk found: the name that it calls, its line, and the event type of a query filter. */
interface SyntaxCall {
  readonly name: string;
  readonly line: number;
  readonly filterType: string | undefined;
}

function lineAt(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

/** Each top-level function, class and variable of a module. A function-valued variable counts as a function. */
function moduleUnits(sourceFile: ts.SourceFile): ModuleUnit[] {
  const units: ModuleUnit[] = [];
  const add = (name: string, node: ts.Node, isFunction: boolean): void => {
    units.push({ name, node, isFunction, start: lineAt(sourceFile, node.getStart(sourceFile)), end: lineAt(sourceFile, node.end) });
  };
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      add(statement.name.text, statement, true);
    } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      add(statement.name.text, statement, false);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const initializer = declaration.initializer;
        const isFunction =
          initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
        add(declaration.name.text, declaration, isFunction);
      }
    }
  }
  return units;
}

/**
 * The units that `root` reaches through the names that it references, with `root`. A property name is not a
 * reference, so `x.name` and `{ name: value }` reach no unit called `name`.
 */
function reachedFrom(units: readonly ModuleUnit[], root: string): Set<string> {
  const byName = new Map(units.map((unit): [string, ModuleUnit] => [unit.name, unit]));
  const reached = new Set<string>([root]);
  const pending = [root];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      visit(node.initializer);
      return;
    }
    if (ts.isIdentifier(node) && byName.has(node.text) && !reached.has(node.text)) {
      reached.add(node.text);
      pending.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    const unit = byName.get(name);
    if (unit === undefined) throw new Error(`the module declares no ${name}`);
    ts.forEachChild(unit.node, visit);
  }
  return reached;
}

/** The event type that the `type` property of a query filter names through an imported constant, if any. */
function filterTypeOf(call: ts.CallExpression): string | undefined {
  const filters = call.arguments[1];
  if (filters === undefined || !ts.isObjectLiteralExpression(filters)) return undefined;
  for (const property of filters.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'type') continue;
    return ts.isIdentifier(property.initializer) ? IMPORTED_EVENT_TYPES.get(property.initializer.text) : undefined;
  }
  return undefined;
}

/** Each call of a module whose callee is a name or a property access, with its line. */
function syntaxCalls(sourceFile: ts.SourceFile): SyntaxCall[] {
  const calls: SyntaxCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name !== undefined) {
        calls.push({ name, line: lineAt(sourceFile, node.getStart(sourceFile)), filterType: filterTypeOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return calls;
}

/** The lines of a list, sorted, as one text that two finders can compare. */
function linesText(lines: readonly number[]): string {
  return [...lines].sort((a, b) => a - b).join(',');
}

/** Runs the census over its modules. Each read maps to the top-level unit that holds its line. */
async function censusOf(files: readonly CensusFile[]): Promise<Census> {
  const scopes = new Map<string, readonly string[]>();
  const functions = new Map<string, readonly string[]>();
  const reads: FoundRead[] = [];
  const mismatches: string[] = [];
  for (const file of files) {
    const source = await readFile(file.path, 'utf8');
    const sourceFile = ts.createSourceFile(file.label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const units = moduleUnits(sourceFile);
    const inScope =
      file.scope.kind === 'every-function'
        ? new Set(['<module>', ...units.map((unit) => unit.name)])
        : reachedFrom(units, file.scope.root);
    const unitAt = (line: number): string =>
      units.find((unit) => unit.start <= line && line <= unit.end)?.name ?? '<module>';
    scopes.set(file.label, units.filter((unit) => inScope.has(unit.name)).map((unit) => unit.name));
    functions.set(
      file.label,
      units.filter((unit) => unit.isFunction && inScope.has(unit.name)).map((unit) => unit.name),
    );

    const calls = syntaxCalls(sourceFile).filter((call) => inScope.has(unitAt(call.line)));
    const sites = scanEventReaders(source, { fileName: file.label, knownConstants: KNOWN_CONSTANTS }).filter((site) =>
      inScope.has(unitAt(site.line)),
    );
    for (const site of sites) {
      const isQuery = site.kind === 'query-discriminant' || site.kind === 'unscoped-query';
      const resolved =
        site.discriminant ??
        (isQuery ? calls.find((call) => call.line === site.line && QUERY_METHODS.has(call.name))?.filterType : undefined);
      const read = site.kind === 'unscoped-query' ? 'event:*' : `event:${resolved ?? '<unresolved>'}`;
      reads.push({ file: file.label, fn: unitAt(site.line), read, line: site.line, finder: 'event-reader scanner' });
    }
    for (const call of calls) {
      if (!READ_HELPERS.has(call.name)) continue;
      reads.push({ file: file.label, fn: unitAt(call.line), read: `helper:${call.name}`, line: call.line, finder: 'syntax walk' });
    }

    const scannedQueries = sites
      .filter((site) => site.kind === 'query-discriminant' || site.kind === 'unscoped-query')
      .map((site) => site.line);
    const walkedQueries = calls.filter((call) => QUERY_METHODS.has(call.name)).map((call) => call.line);
    if (linesText(scannedQueries) !== linesText(walkedQueries)) {
      mismatches.push(
        `${file.label}: the event-reader scanner reports queries at lines [${linesText(scannedQueries)}], ` +
          `and the syntax walk finds query calls at lines [${linesText(walkedQueries)}]`,
      );
    }
  }
  return { files: files.map((file) => file.label), scopes, functions, reads, mismatches };
}

/** The key of a read or of a role entry: the file, the function and the read. */
function readKey(file: string, fn: string, read: string): string {
  return `${file} ${fn} ${read}`;
}

/**
 * The faults of a census against the role table: each read with no role, and each role of a scanned file that
 * matches no read. The message of a read names its file, its function and its event type or helper.
 */
function roleFaults(census: Census, roles: readonly RoleEntry[]): string[] {
  const scanned = roles.filter((role) => census.files.includes(role.file));
  const known = new Set(scanned.map((role) => readKey(role.file, role.fn, role.read)));
  const matched = new Set<string>();
  const faults: string[] = [];
  for (const read of census.reads) {
    const key = readKey(read.file, read.fn, read.read);
    if (known.has(key)) {
      matched.add(key);
      continue;
    }
    faults.push(
      `${read.file} ${read.fn} reads ${read.read} at line ${read.line}, found by the ${read.finder}, ` +
        'and the role table gives that read no role',
    );
  }
  for (const role of scanned) {
    const key = readKey(role.file, role.fn, role.read);
    if (!matched.has(key)) faults.push(`the ${role.role} role of ${key} matches no read in scope`);
  }
  return faults;
}

/** The scope of the census in the tree of this repository. */
const SCOPE: readonly CensusFile[] = [
  { label: HANDLER, path: path.join(REPO_ROOT, HANDLER), scope: { kind: 'every-function' } },
  { label: TOOLS, path: path.join(REPO_ROOT, TOOLS), scope: { kind: 'reached-from', root: COMPLETION_ROOT } },
];

/** The source of the completion module with one more query in the body of `failedAfterCompletion`. */
function withSeededRead(source: string): string {
  const sourceFile = ts.createSourceFile(TOOLS, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const target = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'failedAfterCompletion',
  );
  const body = target?.body;
  if (body === undefined) throw new Error('the completion module declares no failedAfterCompletion');
  const at = body.getStart(sourceFile) + 1;
  return `${source.slice(0, at)}\n  await store.query(streamId, { type: 'gate.executed' });${source.slice(at)}`;
}

describe('the census of the reads that decide a settlement verdict', () => {
  /**
   * The first assertions are denominators, so a scan that shrinks cannot read as clean. Each finder reports reads,
   * and the two agree on the queries. Then each read has exactly one role, and each role matches a read.
   */
  it('SettlementReads_EveryReadHasARole', async () => {
    const census = await censusOf(SCOPE);

    expect(census.functions.get(HANDLER)?.length ?? 0).toBeGreaterThanOrEqual(40);
    expect(census.functions.get(TOOLS)?.length ?? 0).toBeGreaterThanOrEqual(30);
    expect(census.scopes.get(TOOLS)).toEqual(expect.arrayContaining([COMPLETION_ROOT, ...COMPLETION_HELPERS]));
    expect(census.scopes.get(TOOLS)).not.toContain('handleTaskClaim');
    expect(census.reads.length).toBeGreaterThanOrEqual(15);
    expect(census.reads.filter((read) => read.finder === 'event-reader scanner').length).toBeGreaterThanOrEqual(8);
    expect(census.reads.filter((read) => read.finder === 'syntax walk').length).toBeGreaterThanOrEqual(6);
    expect(census.mismatches).toEqual([]);

    expect(roleFaults(census, ROLES)).toEqual([]);
    expect(new Set(ROLES.map((role) => readKey(role.file, role.fn, role.read))).size).toBe(ROLES.length);
    expect(ROLES.filter((role) => role.reason.length === 0)).toEqual([]);
    expect(ROLES.filter((role) => role.role === 'pre-read').map((role) => [role.fn, role.read, role.owner])).toEqual([
      ['planStandingLookup', 'helper:resolveWorkflowState', PLAN_STANDING_OWNER],
    ]);
  });

  /**
   * A copy of the completion module on disk gets one more query, which the role table does not name. The census of
   * the copy fails, and the one fault names the file, the function and the event type. The copy with no seed passes.
   */
  it('SettlementReads_ASeededReadWithNoRole_FailsByName', async () => {
    const dir = makeTempDir('settlement-read-commit-');
    try {
      const source = await readFile(path.join(REPO_ROOT, TOOLS), 'utf8');
      const intact = path.join(dir, 'intact.ts');
      const seeded = path.join(dir, 'seeded.ts');
      await writeFile(intact, source, 'utf8');
      await writeFile(seeded, withSeededRead(source), 'utf8');
      const scope: CensusScope = { kind: 'reached-from', root: COMPLETION_ROOT };

      const control = await censusOf([{ label: TOOLS, path: intact, scope }]);
      const census = await censusOf([{ label: TOOLS, path: seeded, scope }]);

      expect(control.reads.length).toBeGreaterThanOrEqual(7);
      expect(roleFaults(control, ROLES)).toEqual([]);
      expect(census.reads.length).toBe(control.reads.length + 1);
      expect(census.mismatches).toEqual([]);
      const faults = roleFaults(census, ROLES);
      expect(faults).toHaveLength(1);
      expect(faults[0]).toContain(TOOLS);
      expect(faults[0]).toContain('failedAfterCompletion');
      expect(faults[0]).toContain('event:gate.executed');
    } finally {
      await rmrfAsync(dir);
    }
  });
});
