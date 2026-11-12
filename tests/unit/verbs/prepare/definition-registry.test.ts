/**
 * The registry of workflow definitions resolves a type to one registered definition, or to a refusal of prepare.
 *
 * A built-in type reads no file. A type of the server config refuses before the locate step and the read.
 * Each other type reads `.exarchos/workflows/` at the checkout that the locate step gives.
 * Each checkout is a temp directory with real files. A read failure and the read order use a seam of three reads.
 * The expected findings and messages are written by hand from the files that each case writes.
 *
 * @oracle-sources: ../../../../src/verbs/prepare/definition-registry.ts, ../../../helpers/definitions/user-definition.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import ts from 'typescript';

import { contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import {
  BUILT_IN_ENTRIES,
  readCheckoutDefinitions,
  registerDefinition,
  resolveDefinition,
  type CheckoutLocation,
  type DefinitionReads,
  type RegisteredDefinition,
} from '../../../../src/verbs/prepare/definition-registry.js';
import type { PrepareRefusal } from '../../../../src/verbs/prepare/types.js';
import { BUILT_IN_WORKFLOW_TYPES, builtInDefinition } from '../../../../src/workflow/definitions/built-in.js';
import { checkUserDefinition } from '../../../../src/workflow/definitions/user.js';
import { canonicalPath } from '../../../../src/utils/git-tree.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { releaseCheckDefinition } from '../../../helpers/definitions/user-definition.js';

/** The registry module that the structural case parses. */
const REGISTRY_MODULE = path.resolve(import.meta.dirname, '../../../../src/verbs/prepare/definition-registry.ts');

/** The stream of each resolution. */
const STREAM = 'feat-definition-registry';

/** The type of the fixture user definition. */
const USER_TYPE = 'release-check';

/** The largest definition file that the read accepts, in bytes. */
const BOUND = 262144;

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rmrfAsync(dir);
});

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as an object, or throws with its path. */
function recordAt(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${at} is not an object`);
  return value;
}

/** A new temp directory in canonical form, which the case deletes after it ends. */
async function tempDir(prefix: string): Promise<string> {
  const dir = canonicalPath(await mkdtemp(path.join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

/** The JSON text of a document. */
function jsonOf(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** A new checkout whose `.exarchos/workflows/` directory holds each named file with its text. */
async function checkoutWith(files: Readonly<Record<string, string>>): Promise<string> {
  const checkout = await tempDir('definition-registry-');
  await mkdir(path.join(checkout, '.exarchos', 'workflows'), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(checkout, '.exarchos', 'workflows', name), text);
  }
  return checkout;
}

/** A locate step that gives the checkout as the root of its work tree. */
function locateAt(toplevel: string) {
  const location: CheckoutLocation = {
    ok: true,
    located: { kind: 'repository', toplevel, repository: path.join(toplevel, '.git') },
  };
  return vi.fn<() => Promise<CheckoutLocation>>(async () => location);
}

/** The three reads of `node:fs/promises`, each wrapped in a spy. */
function spyReads() {
  return {
    lstat: vi.fn((file: string) => lstat(file)),
    readdir: vi.fn((dir: string) => readdir(dir)),
    readFile: vi.fn((file: string) => readFile(file)),
  };
}

/** An error of a file read with the code. */
function readError(code: string): Error {
  return Object.assign(new Error(`${code}: the read failed`), { code });
}

/** The fixture document with one authority statement changed, so its digest differs. */
function editedFixture(): Record<string, unknown> {
  const document = structuredClone(releaseCheckDefinition());
  recordAt(document.authority, 'authority').invariants = [
    { id: 'release-history', statement: 'A recorded release check is kept as it is.' },
  ];
  return document;
}

/**
 * The fixture document with the presence of the approval of `verify->completed` inside a chain of `not` nodes.
 * The document, `exarchos`, `edges`, the edge, the obligation and the outer presence node are six levels.
 * Each `not` node below the outer node adds one level, so the document nests `6 + count` levels deep.
 */
function deepFixture(count: number): Record<string, unknown> {
  const document = structuredClone(releaseCheckDefinition());
  const edges = recordAt(recordAt(document.exarchos, 'exarchos').edges, 'exarchos.edges');
  const obligation = recordAt(recordAt(edges['verify->completed'], 'verify->completed').obligation, 'obligation');
  let presence: unknown = obligation.presence;
  for (let index = 0; index < count; index += 1) presence = { kind: 'not', operand: presence };
  obligation.presence = presence;
  return document;
}

/** The levels of arrays and objects in a JSON value, counted by recursion. A scalar has no level. */
function levelsOf(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const children: readonly unknown[] = Object.values(value);
  return 1 + Math.max(0, ...children.map(levelsOf));
}

/** The checked definition of a raw document, or a throw when the user rules refuse it. */
function checkedDefinition(document: unknown) {
  const checked = checkUserDefinition(document);
  if (!checked.ok) throw new Error(`the document fails the user rules: ${JSON.stringify(checked.findings)}`);
  return checked.definition;
}

/** The refusal of a resolution. A resolution that holds a definition fails the assertion. */
function refusalOf(resolution: Awaited<ReturnType<typeof resolveDefinition>>): PrepareRefusal {
  expect(resolution).toMatchObject({ ok: false });
  if (resolution.ok) throw new Error(`the type resolved to ${resolution.registered.workflowType}`);
  return resolution.refusal;
}

/** The registered definition of a resolution. A refusal fails the assertion. */
function registeredOf(resolution: Awaited<ReturnType<typeof resolveDefinition>>): RegisteredDefinition {
  expect(resolution).toMatchObject({ ok: true });
  if (!resolution.ok) throw new Error(`the type refused: ${resolution.refusal.message}`);
  return resolution.registered;
}

/** Each object literal of a module that holds a `source` property. */
function sourcedLiterals(file: ts.SourceFile): ts.ObjectLiteralExpression[] {
  const found: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some((property) => property.name !== undefined && ts.isIdentifier(property.name) && property.name.text === 'source')
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The `registerDefinition` call whose second argument is the literal, or `undefined`. */
function addPathCallOf(literal: ts.ObjectLiteralExpression): ts.CallExpression | undefined {
  const call = literal.parent;
  if (!ts.isCallExpression(call)) return undefined;
  const callee = call.expression;
  return ts.isIdentifier(callee) && callee.text === 'registerDefinition' && call.arguments[1] === literal ? call : undefined;
}

describe('the registry of workflow definitions', () => {
  /** Each built-in type gives its frozen entry. The locate step and the reads do not run. */
  it('DefinitionRegistry_ABuiltInType_ResolvesWithNoRead', async () => {
    for (const workflowType of BUILT_IN_WORKFLOW_TYPES) {
      const locateCheckout = locateAt(await tempDir('definition-registry-unused-'));
      const reads = spyReads();
      const resolution = await resolveDefinition({
        streamId: STREAM,
        workflowType,
        locateCheckout,
        configWorkflowTypes: [workflowType],
        reads,
      });

      expect(resolution).toStrictEqual({ ok: true, registered: BUILT_IN_ENTRIES.get(workflowType) });
      expect(registeredOf(resolution).definition).toBe(builtInDefinition(workflowType));
      expect(registeredOf(resolution).source).toStrictEqual({ kind: 'built-in' });
      expect(locateCheckout).not.toHaveBeenCalled();
      expect(reads.lstat).not.toHaveBeenCalled();
      expect(reads.readdir).not.toHaveBeenCalled();
      expect(reads.readFile).not.toHaveBeenCalled();
    }
  });

  /**
   * The parse of the registry module finds each object literal with a `source` property.
   * Each one is the second argument of a `registerDefinition` call, and two calls at least hold one.
   * The five built-in entries also equal the output of the add path over the frozen definitions.
   */
  it('DefinitionRegistry_TheBuiltInEntries_GoThroughTheAddPath', () => {
    const module = ts.createSourceFile(REGISTRY_MODULE, readFileSync(REGISTRY_MODULE, 'utf8'), ts.ScriptTarget.Latest, true);
    const literals = sourcedLiterals(module);
    const outside = literals.filter((literal) => addPathCallOf(literal) === undefined).map((literal) => literal.getText(module));
    const calls = new Set(literals.map(addPathCallOf));

    expect(outside).toStrictEqual([]);
    expect(calls.size).toBeGreaterThanOrEqual(2);

    let expected: ReadonlyMap<string, RegisteredDefinition> = new Map();
    for (const workflowType of BUILT_IN_WORKFLOW_TYPES) {
      const definition = builtInDefinition(workflowType);
      const registered = registerDefinition(expected, {
        workflowType,
        source: { kind: 'built-in' },
        digest: contentDigest(definition),
        definition,
      });
      if (!registered.ok) throw new Error(`the built-in type ${workflowType} registers twice`);
      expected = registered.entries;
    }
    expect(BUILT_IN_ENTRIES).toStrictEqual(expected);
    expect([...BUILT_IN_ENTRIES.keys()]).toStrictEqual([...BUILT_IN_WORKFLOW_TYPES]);
  });

  /** The kernel `name` of a file is its type, so a file named `checks.json` declares `release-check`. */
  it('DefinitionRegistry_AUserFile_ResolvesByItsName', async () => {
    const checkout = await checkoutWith({ 'checks.json': jsonOf(releaseCheckDefinition()) });
    const locateCheckout = locateAt(checkout);
    const resolution = await resolveDefinition({
      streamId: STREAM,
      workflowType: USER_TYPE,
      locateCheckout,
      configWorkflowTypes: [],
    });
    const definition = checkedDefinition(releaseCheckDefinition());

    expect(resolution).toStrictEqual({
      ok: true,
      registered: {
        workflowType: USER_TYPE,
        source: { kind: 'checkout', file: '.exarchos/workflows/checks.json' },
        digest: contentDigest(definition),
        definition,
      },
      located: { kind: 'repository', toplevel: checkout, repository: path.join(checkout, '.git') },
    });
    expect(locateCheckout).toHaveBeenCalledTimes(1);
  });

  /** Two files with one type and one digest are one entry, the earlier file. The bytes of the two files differ. */
  it('DefinitionRegistry_TheSameNameAndDigestTwice_IsOneEntry', async () => {
    const checkout = await checkoutWith({
      'b-second.json': JSON.stringify(releaseCheckDefinition()),
      'a-first.json': jsonOf(releaseCheckDefinition()),
    });
    const read = await readCheckoutDefinitions(checkout);

    expect(read.findings).toStrictEqual([]);
    expect([...read.entries.keys()]).toStrictEqual([USER_TYPE]);
    expect(read.entries.get(USER_TYPE)?.source).toStrictEqual({ kind: 'checkout', file: '.exarchos/workflows/a-first.json' });

    const held = read.entries;
    const again = registerDefinition(held, {
      workflowType: USER_TYPE,
      source: { kind: 'checkout', file: '.exarchos/workflows/c-third.json' },
      digest: contentDigest(checkedDefinition(releaseCheckDefinition())),
      definition: checkedDefinition(releaseCheckDefinition()),
    });
    expect(again).toStrictEqual({ ok: true, entries: held });
    expect(again.ok && again.entries).toBe(held);
  });

  /** The later file in name order is the `file` of the finding, and the earlier file is its one path key. */
  it('DefinitionRegistry_TheSameNameWithAnotherDigest_NamesBothFiles', async () => {
    const checkout = await checkoutWith({
      'b-second.json': jsonOf(editedFixture()),
      'a-first.json': jsonOf(releaseCheckDefinition()),
    });
    const read = await readCheckoutDefinitions(checkout);

    expect(read.findings).toStrictEqual([
      { file: '.exarchos/workflows/b-second.json', rule: 'duplicate-name', path: ['.exarchos/workflows/a-first.json'] },
    ]);
    expect(read.entries.get(USER_TYPE)?.source).toStrictEqual({ kind: 'checkout', file: '.exarchos/workflows/a-first.json' });

    const refusal = refusalOf(
      await resolveDefinition({ streamId: STREAM, workflowType: USER_TYPE, locateCheckout: locateAt(checkout), configWorkflowTypes: [] }),
    );
    expect(refusal.message.split('\n').slice(1)).toStrictEqual([
      '.exarchos/workflows/b-second.json duplicate-name .exarchos/workflows/a-first.json',
    ]);
  });

  /** The `readdir` of the seam gives `a.json` before `Z.json`. Code-unit order puts `Z.json` first. */
  it('DefinitionRegistry_TheFilesOfADirectory_AreReadInNameOrder', async () => {
    const checkout = await checkoutWith({ 'Z.json': 'not json', 'a.json': 'not json' });
    const reads: DefinitionReads = {
      lstat: (file) => lstat(file),
      readdir: async () => ['a.json', 'Z.json'],
      readFile: (file) => readFile(file),
    };
    const read = await readCheckoutDefinitions(checkout, reads);

    expect(read.findings).toStrictEqual([
      { file: '.exarchos/workflows/Z.json', rule: 'definition-json', path: [] },
      { file: '.exarchos/workflows/a.json', rule: 'definition-json', path: [] },
    ]);
  });

  /** The message lists five lines `<file> <rule> <path>` in name order, then the count of the rest. */
  it('DefinitionRegistry_SixFindings_ListFiveLinesAndTheCountOfTheRest', async () => {
    const names = ['a.json', 'b.json', 'c.json', 'd.json', 'e.json', 'f.json'];
    const checkout = await checkoutWith(Object.fromEntries(names.map((name) => [name, 'not json'])));
    const refusal = refusalOf(
      await resolveDefinition({ streamId: STREAM, workflowType: USER_TYPE, locateCheckout: locateAt(checkout), configWorkflowTypes: [] }),
    );
    const lines = refusal.message.split('\n');

    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(lines[0]).toContain('(finding: definition-invalid)');
    expect(lines.slice(1)).toStrictEqual([
      '.exarchos/workflows/a.json definition-json',
      '.exarchos/workflows/b.json definition-json',
      '.exarchos/workflows/c.json definition-json',
      '.exarchos/workflows/d.json definition-json',
      '.exarchos/workflows/e.json definition-json',
      'and 1 more',
    ]);
    expect(refusal.message).not.toContain('f.json');
  });

  /** A file that declares a built-in type fails `user-name`. The built-in type still resolves with no read. */
  it('DefinitionRegistry_ABuiltInNamedFile_IsRefused', async () => {
    const document = structuredClone(releaseCheckDefinition());
    document.name = 'feature';
    const checkout = await checkoutWith({ 'feature.json': jsonOf(document) });
    const read = await readCheckoutDefinitions(checkout);

    expect(read).toStrictEqual({
      entries: new Map(),
      findings: [{ file: '.exarchos/workflows/feature.json', rule: 'user-name', path: ['name'] }],
    });

    const reads = spyReads();
    const builtIn = await resolveDefinition({
      streamId: STREAM,
      workflowType: 'feature',
      locateCheckout: locateAt(checkout),
      configWorkflowTypes: [],
      reads,
    });
    expect(registeredOf(builtIn)).toBe(BUILT_IN_ENTRIES.get('feature'));
    expect(reads.lstat).not.toHaveBeenCalled();
  });

  /** Bytes that are not JSON give a `definition-json` finding and no entry. */
  it('DefinitionRegistry_AFileThatIsNotJson_IsRefused', async () => {
    const checkout = await checkoutWith({ 'broken.json': '{ "name": "release-check",' });
    const read = await readCheckoutDefinitions(checkout);

    expect(read).toStrictEqual({
      entries: new Map(),
      findings: [{ file: '.exarchos/workflows/broken.json', rule: 'definition-json', path: [] }],
    });
  });

  /** A valid file of the type and a broken sibling of another type: the type refuses with the finding of the sibling. */
  it('DefinitionRegistry_ABrokenSibling_RefusesEveryUserType', async () => {
    const sibling = structuredClone(releaseCheckDefinition());
    sibling.name = 'other-check';
    recordAt(sibling.authority, 'authority').delegatedDecisions = [];
    const checkout = await checkoutWith({ 'release-check.json': jsonOf(releaseCheckDefinition()), 'zz-other.json': jsonOf(sibling) });
    const read = await readCheckoutDefinitions(checkout);

    expect([...read.entries.keys()]).toStrictEqual([USER_TYPE]);
    expect(read.findings).toStrictEqual([{ file: '.exarchos/workflows/zz-other.json', rule: 'user-authority', path: ['authority'] }]);

    const refusal = refusalOf(
      await resolveDefinition({ streamId: STREAM, workflowType: USER_TYPE, locateCheckout: locateAt(checkout), configWorkflowTypes: [] }),
    );
    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: definition-invalid)');
    expect(refusal.message.split('\n').slice(1)).toStrictEqual(['.exarchos/workflows/zz-other.json user-authority authority']);
  });

  /** `ENOENT` from the `lstat` of either directory is absence. It gives no entry and no finding. */
  it.each<[string, (checkout: string) => Promise<void>]>([
    ['NoExarchos', async () => undefined],
    ['NoWorkflows', async (checkout) => mkdir(path.join(checkout, '.exarchos')).then(() => undefined)],
  ])('DefinitionRegistry_%s_NoDirectory_GivesNoEntry', async (_row, arrange) => {
    const checkout = await tempDir('definition-registry-absent-');
    await arrange(checkout);
    const read = await readCheckoutDefinitions(checkout);

    expect(read).toStrictEqual({ entries: new Map(), findings: [] });

    const refusal = refusalOf(
      await resolveDefinition({ streamId: STREAM, workflowType: USER_TYPE, locateCheckout: locateAt(checkout), configWorkflowTypes: [] }),
    );
    expect(refusal.message).toContain('(finding: no-definition)');
  });

  /** A file above 262144 bytes gives `size`. A file of exactly 262144 bytes registers. */
  it('DefinitionRegistry_AFileAboveTheBound_IsRefused', async () => {
    const text = JSON.stringify(releaseCheckDefinition());
    const checkout = await checkoutWith({
      'big.json': text.padEnd(BOUND + 1, ' '),
      'fit.json': text.padEnd(BOUND, ' '),
    });
    const read = await readCheckoutDefinitions(checkout);

    expect(read.findings).toStrictEqual([{ file: '.exarchos/workflows/big.json', rule: 'definition-file', path: ['size'] }]);
    expect(read.entries.get(USER_TYPE)?.source).toStrictEqual({ kind: 'checkout', file: '.exarchos/workflows/fit.json' });
  });

  /**
   * A file of 65 levels, far under the size bound, gives a `definition-file` finding with the one key `depth`.
   * The refusal of the type names the file, the rule and the key.
   */
  it('ReadDefinitions_AFileDeeperThanTheBound_IsRefusedWithDepth', async () => {
    const document = deepFixture(59);
    const text = jsonOf(document);
    expect(levelsOf(document)).toBe(65);
    expect(text.length).toBeLessThan(BOUND);
    const checkout = await checkoutWith({ 'deep.json': text });

    const read = await readCheckoutDefinitions(checkout);

    expect(read).toStrictEqual({
      entries: new Map(),
      findings: [{ file: '.exarchos/workflows/deep.json', rule: 'definition-file', path: ['depth'] }],
    });
    const refusal = refusalOf(
      await resolveDefinition({ streamId: STREAM, workflowType: USER_TYPE, locateCheckout: locateAt(checkout), configWorkflowTypes: [] }),
    );
    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: definition-invalid)');
    expect(refusal.message.split('\n').slice(1)).toStrictEqual(['.exarchos/workflows/deep.json definition-file depth']);
  });

  /** A file of exactly 64 levels, with a condition that the user rules accept at that depth, registers. */
  it('ReadDefinitions_AFileAtTheBound_IsRead', async () => {
    const document = deepFixture(58);
    expect(levelsOf(document)).toBe(64);
    const checkout = await checkoutWith({ 'deep.json': jsonOf(document) });

    const read = await readCheckoutDefinitions(checkout);

    expect(read.findings).toStrictEqual([]);
    expect(read.entries.get(USER_TYPE)?.source).toStrictEqual({ kind: 'checkout', file: '.exarchos/workflows/deep.json' });
    expect(read.entries.get(USER_TYPE)?.digest).toBe(contentDigest(checkedDefinition(document)));
  });

  /**
   * A link entry gives `not-a-regular-file`, though its target is a valid definition file. On win32 the link is a
   * junction to a directory that holds such a file, because a junction targets a directory only.
   */
  it('DefinitionRegistry_ALinkedFile_IsRefused', async () => {
    const outside = await tempDir('definition-registry-outside-');
    await writeFile(path.join(outside, 'release-check.json'), jsonOf(releaseCheckDefinition()));
    const checkout = await checkoutWith({});
    const link = path.join(checkout, '.exarchos', 'workflows', 'link.json');
    if (process.platform === 'win32') await symlink(outside, link, 'junction');
    else await symlink(path.join(outside, 'release-check.json'), link, 'file');
    const read = await readCheckoutDefinitions(checkout);

    expect(read).toStrictEqual({
      entries: new Map(),
      findings: [{ file: '.exarchos/workflows/link.json', rule: 'definition-file', path: ['not-a-regular-file'] }],
    });
  });

  /** A link or a regular file at `.exarchos` or at `.exarchos/workflows` gives `not-a-directory` at that path. */
  it.each<[string, string, (checkout: string, outside: string) => Promise<void>]>([
    ['ALinkAtExarchos', '.exarchos', async (checkout, outside) => linkDirectory(outside, path.join(checkout, '.exarchos'))],
    [
      'ALinkAtWorkflows',
      '.exarchos/workflows',
      async (checkout, outside) => {
        await mkdir(path.join(checkout, '.exarchos'));
        await linkDirectory(path.join(outside, 'workflows'), path.join(checkout, '.exarchos', 'workflows'));
      },
    ],
    ['AFileAtExarchos', '.exarchos', async (checkout) => writeFile(path.join(checkout, '.exarchos'), 'a file')],
    [
      'AFileAtWorkflows',
      '.exarchos/workflows',
      async (checkout) => {
        await mkdir(path.join(checkout, '.exarchos'));
        await writeFile(path.join(checkout, '.exarchos', 'workflows'), 'a file');
      },
    ],
  ])('DefinitionRegistry_%s_InPlaceOfADirectory_IsRefused', async (_row, file, arrange) => {
    const outside = await tempDir('definition-registry-target-');
    await mkdir(path.join(outside, 'workflows'));
    await writeFile(path.join(outside, 'workflows', 'release-check.json'), jsonOf(releaseCheckDefinition()));
    const checkout = await tempDir('definition-registry-in-place-');
    await arrange(checkout, outside);
    const read = await readCheckoutDefinitions(checkout);

    expect(read).toStrictEqual({ entries: new Map(), findings: [{ file, rule: 'definition-file', path: ['not-a-directory'] }] });
  });

  /** A read error other than an absent directory refuses, and the path of the finding names the code. */
  it.each<[string, string, string, (checkout: string) => DefinitionReads]>([
    [
      'TheLstatOfExarchos',
      '.exarchos',
      'EACCES',
      (checkout) => ({
        lstat: async (file) => {
          if (file === path.join(checkout, '.exarchos')) throw readError('EACCES');
          return lstat(file);
        },
        readdir: (dir) => readdir(dir),
        readFile: (file) => readFile(file),
      }),
    ],
    [
      'TheReaddir',
      '.exarchos/workflows',
      'EACCES',
      () => ({
        lstat: (file) => lstat(file),
        readdir: async () => {
          throw readError('EACCES');
        },
        readFile: (file) => readFile(file),
      }),
    ],
    [
      'TheReadFile',
      '.exarchos/workflows/release-check.json',
      'EISDIR',
      () => ({
        lstat: (file) => lstat(file),
        readdir: (dir) => readdir(dir),
        readFile: async () => {
          throw readError('EISDIR');
        },
      }),
    ],
  ])('DefinitionRegistry_%s_AReadFailure_IsRefused', async (_row, file, code, readsAt) => {
    const checkout = await checkoutWith({ 'release-check.json': jsonOf(releaseCheckDefinition()) });
    const read = await readCheckoutDefinitions(checkout, readsAt(checkout));

    expect(read).toStrictEqual({ entries: new Map(), findings: [{ file, rule: 'definition-file', path: [code] }] });
  });

  /** An entry whose name does not end in `.json` is not read, whatever its bytes or its kind. */
  it('DefinitionRegistry_ANonJsonName_IsIgnored', async () => {
    const checkout = await checkoutWith({
      'release-check.json': jsonOf(releaseCheckDefinition()),
      'notes.md': 'not json',
      'release-check.json.bak': '{',
    });
    await mkdir(path.join(checkout, '.exarchos', 'workflows', 'drafts'));
    const reads = spyReads();
    const read = await readCheckoutDefinitions(checkout, reads);

    expect(read.findings).toStrictEqual([]);
    expect([...read.entries.keys()]).toStrictEqual([USER_TYPE]);
    expect(reads.lstat.mock.calls.map(([file]) => path.basename(file))).toStrictEqual([
      '.exarchos',
      'workflows',
      'release-check.json',
    ]);
  });

  /**
   * The digest is the content digest of the whole definition, with its extension. Two files that differ in the
   * extension only have one kernel and two digests, so the later file gives `duplicate-name`.
   */
  it('DefinitionRegistry_TheDigest_CoversTheExtension', async () => {
    const edited = structuredClone(releaseCheckDefinition());
    const edges = recordAt(recordAt(edited.exarchos, 'exarchos').edges, 'exarchos.edges');
    recordAt(edges['scope->build'], 'scope->build').category = 'admission-requirement';
    const checkout = await checkoutWith({ 'a.json': jsonOf(releaseCheckDefinition()), 'b.json': jsonOf(edited) });
    const read = await readCheckoutDefinitions(checkout);
    const definition = checkedDefinition(releaseCheckDefinition());
    const { exarchos: _extension, ...kernel } = definition;
    const { exarchos: _editedExtension, ...editedKernel } = checkedDefinition(edited);

    expect(editedKernel).toStrictEqual(kernel);
    expect(read.entries.get(USER_TYPE)?.digest).toBe(contentDigest(definition));
    expect(read.entries.get(USER_TYPE)?.digest).not.toBe(contentDigest(kernel));
    expect(read.findings).toStrictEqual([
      { file: '.exarchos/workflows/b.json', rule: 'duplicate-name', path: ['.exarchos/workflows/a.json'] },
    ]);
  });

  /** The read runs at the root of the work tree that the locate step gives, and nowhere else. */
  it('DefinitionRegistry_TheCheckoutOfTheLocate_IsTheDirectoryRoot', async () => {
    const checkout = await checkoutWith({ 'release-check.json': jsonOf(releaseCheckDefinition()) });
    const reads = spyReads();
    const resolution = await resolveDefinition({
      streamId: STREAM,
      workflowType: USER_TYPE,
      locateCheckout: locateAt(checkout),
      configWorkflowTypes: [],
      reads,
    });

    expect(reads.lstat.mock.calls.map(([file]) => file)).toStrictEqual([
      path.join(checkout, '.exarchos'),
      path.join(checkout, '.exarchos', 'workflows'),
      path.join(checkout, '.exarchos', 'workflows', 'release-check.json'),
    ]);
    expect(reads.readdir.mock.calls).toStrictEqual([[path.join(checkout, '.exarchos', 'workflows')]]);
    expect(registeredOf(resolution).source).toStrictEqual({ kind: 'checkout', file: '.exarchos/workflows/release-check.json' });
  });

  /** The refusal of the locate step is the refusal of the result, the same object. The reads do not run. */
  it('DefinitionRegistry_ALocateRefusal_PassesThroughUnchanged', async () => {
    const refusal: PrepareRefusal = { code: 'SCOPE_UNRESOLVED', message: 'the locate step refused /nowhere (finding: no-work-tree)' };
    const reads = spyReads();
    const resolution = await resolveDefinition({
      streamId: STREAM,
      workflowType: USER_TYPE,
      locateCheckout: async () => ({ ok: false, refusal }),
      configWorkflowTypes: [],
      reads,
    });

    expect(refusalOf(resolution)).toBe(refusal);
    expect(reads.lstat).not.toHaveBeenCalled();
    expect(reads.readdir).not.toHaveBeenCalled();
    expect(reads.readFile).not.toHaveBeenCalled();
  });

  /** A type of the `workflows:` key refuses with `config-workflow`. The message names the key, its retirement and its replacement. */
  it('DefinitionRegistry_AConfigWorkflowsType_HasTheConfigFinding', async () => {
    const checkout = await checkoutWith({});
    const refusal = refusalOf(
      await resolveDefinition({
        streamId: STREAM,
        workflowType: 'custom-flow',
        locateCheckout: locateAt(checkout),
        configWorkflowTypes: ['other-flow', 'custom-flow'],
      }),
    );

    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: config-workflow)');
    expect(refusal.message).toContain('workflows:');
    expect(refusal.message).toContain('v3.0');
    expect(refusal.message).toContain('.exarchos/workflows/');

    const other = refusalOf(
      await resolveDefinition({
        streamId: STREAM,
        workflowType: 'custom-flow',
        locateCheckout: locateAt(checkout),
        configWorkflowTypes: ['other-flow'],
      }),
    );
    expect(other.message).toContain('(finding: no-definition)');
  });

  /** A valid file of the config type changes nothing. The locate step and the reads do not run. */
  it('DefinitionRegistry_AConfigTypeWithAFile_IsRefusedBeforeTheLocateAndTheRead', async () => {
    const checkout = await checkoutWith({ 'release-check.json': jsonOf(releaseCheckDefinition()) });
    const locateCheckout = locateAt(checkout);
    const reads = spyReads();
    const refusal = refusalOf(
      await resolveDefinition({ streamId: STREAM, workflowType: USER_TYPE, locateCheckout, configWorkflowTypes: [USER_TYPE], reads }),
    );

    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: config-workflow)');
    expect(locateCheckout).not.toHaveBeenCalled();
    expect(reads.lstat).not.toHaveBeenCalled();
    expect(reads.readdir).not.toHaveBeenCalled();
    expect(reads.readFile).not.toHaveBeenCalled();
  });

  /** A type that no built-in, no file and no config entry declares refuses. The message names the directory of the checkout. */
  it('DefinitionRegistry_AnUnregisteredType_HasTheNoDefinitionFinding', async () => {
    const checkout = await checkoutWith({ 'release-check.json': jsonOf(releaseCheckDefinition()) });
    const refusal = refusalOf(
      await resolveDefinition({ streamId: STREAM, workflowType: 'other-flow', locateCheckout: locateAt(checkout), configWorkflowTypes: [] }),
    );

    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: no-definition)');
    expect(refusal.message).toContain(`'other-flow'`);
    expect(refusal.message).toContain(path.join(checkout, '.exarchos', 'workflows'));
  });

  /** A stream with no type refuses with `untyped`, before the locate step. */
  it('DefinitionRegistry_AnUntypedStream_HasTheUntypedFinding', async () => {
    const locateCheckout = locateAt(await tempDir('definition-registry-untyped-'));
    const refusal = refusalOf(
      await resolveDefinition({ streamId: STREAM, workflowType: undefined, locateCheckout, configWorkflowTypes: [] }),
    );

    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: untyped)');
    expect(refusal.message).toContain(`'${STREAM}'`);
    expect(locateCheckout).not.toHaveBeenCalled();
  });
});

/** Links a directory: a directory link on POSIX, and a junction on win32, which needs no privilege. */
async function linkDirectory(target: string, link: string): Promise<void> {
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
