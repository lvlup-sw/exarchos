// A class that owns a SQLite handle and has a `close()` method must not open a
// handle after `close()` runs. An append that is still in flight can reach the
// lazy open after the owner closes. Then the new handle has no owner, and on
// Windows it keeps `exarchos.db` locked.
//
// This guard parses every tracked source file under `src/`. In each class that
// declares `close()`, it finds each `new SqliteBackend(...)` and each
// `new Database(...)` outside the constructor. Each one must come after a call
// to `this.assertOpen()` in the same member. The tests also prove that the scan
// covers the source tree and the known owners. They prove that the matcher
// finds a seeded violation and accepts a clean twin.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { listTrackedFiles } from '../../tools/test-helpers/tracked-population.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** Constructors that open a SQLite file handle. */
const OPENERS = new Set(['SqliteBackend', 'Database']);

/** The call that must come first in any member that opens a handle. */
const BARRIER_METHOD = 'assertOpen';

interface OpenSite {
  readonly site: string;
  readonly guarded: boolean;
}

function memberName(member: ts.ClassElement, sourceFile: ts.SourceFile): string {
  return member.name === undefined ? '<anonymous>' : member.name.getText(sourceFile);
}

function memberBody(member: ts.ClassElement): ts.Node | undefined {
  if (ts.isConstructorDeclaration(member)) return undefined;
  if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    return member.body;
  }
  const init = ts.isPropertyDeclaration(member) ? member.initializer : undefined;
  if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init;
  return undefined;
}

function isBarrierCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
    node.expression.name.text === BARRIER_METHOD
  );
}

function isOpener(node: ts.Node): node is ts.NewExpression {
  return ts.isNewExpression(node) && ts.isIdentifier(node.expression) && OPENERS.has(node.expression.text);
}

function scanClass(cls: ts.ClassLikeDeclaration, sourceFile: ts.SourceFile, sites: OpenSite[]): void {
  const hasClose = cls.members.some(
    (member) => ts.isMethodDeclaration(member) && memberName(member, sourceFile) === 'close',
  );
  if (!hasClose) return;
  const owner = cls.name?.text ?? '<anonymous>';
  for (const member of cls.members) {
    const body = memberBody(member);
    if (body === undefined) continue;
    const barriers: number[] = [];
    const opens: ts.NewExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (isBarrierCall(node)) barriers.push(node.getStart(sourceFile));
      if (isOpener(node)) opens.push(node);
      ts.forEachChild(node, visit);
    };
    visit(body);
    for (const open of opens) {
      const at = open.getStart(sourceFile);
      sites.push({
        site: `${owner}.${memberName(member, sourceFile)}`,
        guarded: barriers.some((position) => position < at),
      });
    }
  }
}

/** Every handle-opening site inside a class that declares `close()`. */
function scanSource(fileName: string, source: string): OpenSite[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: OpenSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) scanClass(node, sourceFile, sites);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

async function scanTree(): Promise<{ readonly filesScanned: number; readonly sites: readonly OpenSite[] }> {
  const files = await listTrackedFiles(REPO_ROOT, {
    exclude: (rel) => !rel.startsWith('src/') || rel.endsWith('.test.ts'),
  });
  const sites: OpenSite[] = [];
  for (const rel of files) {
    const source = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    if (!source.includes('new SqliteBackend(') && !source.includes('new Database(')) continue;
    sites.push(...scanSource(rel, source));
  }
  return { filesScanned: files.length, sites };
}

describe('SQLite handle owners refuse to reopen after close (#2026)', () => {
  /** Without these floors, a moved tree or a broken filter leaves nothing to check. */
  it('SqliteOwnerGuard_ScansTheSourceTreeAndTheKnownOwners', async () => {
    const { filesScanned, sites } = await scanTree();

    expect(filesScanned).toBeGreaterThan(500);
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const known of [
      'AtomicAppender.ensureSqliteBackend',
      'AtomicAppender.ensureSqliteBackendSync',
      'SqliteBackend.initialize',
    ]) {
      expect(sites.map((s) => s.site)).toContain(known);
    }
  });

  it('SqliteOwnerGuard_EveryOpenComesAfterTheCloseBarrier', async () => {
    const { sites } = await scanTree();
    const unguarded = sites.filter((s) => !s.guarded).map((s) => s.site);

    expect(sites.length).toBeGreaterThanOrEqual(3);
    expect(unguarded).toEqual([]);
  });

  /** The seeded owner is the shape that leaked: a lazy open with no barrier, or a barrier too late. */
  it('SqliteOwnerGuard_Matcher_FindsSeededViolations', () => {
    const seeded = [
      'class Leaky {',
      '  private backend?: SqliteBackend;',
      '  open(): SqliteBackend {',
      "    this.backend ??= new SqliteBackend('x.db');",
      '    return this.backend;',
      '  }',
      '  late(): void {',
      "    const db = new Database('x.db');",
      '    this.assertOpen();',
      '    db.close();',
      '  }',
      '  close(): void {}',
      '}',
    ].join('\n');

    expect(scanSource('seeded.ts', seeded)).toEqual([
      { site: 'Leaky.open', guarded: false },
      { site: 'Leaky.late', guarded: false },
    ]);
  });

  /** The clean twin: a barrier first, eager opens at construction, no close, a free function. */
  it('SqliteOwnerGuard_Matcher_AcceptsTheCleanTwin', () => {
    const clean = [
      'class Owner {',
      "  private readonly eager = new SqliteBackend('a.db');",
      "  constructor() { new Database('b.db'); }",
      '  open(): SqliteBackend {',
      '    this.assertOpen();',
      "    return new SqliteBackend('x.db');",
      '  }',
      "  readonly reopen = (): SqliteBackend => { this.assertOpen(); return new SqliteBackend('w.db'); };",
      '  close(): void {}',
      '}',
      "class NoClose { open() { return new SqliteBackend('y.db'); } }",
      "function openStore() { return new SqliteBackend('z.db'); }",
    ].join('\n');

    const sites = scanSource('clean.ts', clean);

    expect(sites).toEqual([
      { site: 'Owner.open', guarded: true },
      { site: 'Owner.reopen', guarded: true },
    ]);
  });
});
