/** Reader witnesses cover byte authority, strict syntax, fence boundaries and exact identifiers. */
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readDesignRecord, readDesignRecordAt } from '../../../../src/workflow/design-record/read.js';
import type { DesignRecordSnapshot } from '../../../../src/workflow/design-record/schema.js';

const fixturePath = path.resolve(import.meta.dirname, '../../../helpers/fixtures/design-record/typed-standard.md');
const fixture = await readFile(fixturePath);
const reference = 'docs/specs/example.md';
const task = {
  id: 'T-01', title: 'Read the file', implements: ['DR-1'], blockedBy: [] as string[],
  files: ['docs/plan.md'], testFiles: [], riskTier: 'low', boundaryTouching: false,
  testLayer: 'unit', acceptance: ['Exact bytes survive.'], instructions: 'Keep the source.', parallelizable: false,
};
const plan = { version: 1, requirements: ['DR-1'], tasks: [task] };

function record(body: string, fence = '```', info = 'exarchos-plan-v1'): Buffer {
  return Buffer.from(`## Design & Rationale\n### DR-1: Exact source\n\n${fence}${info}\n${body}\n${fence}\n`);
}

function snapshot(bytes: Uint8Array): DesignRecordSnapshot {
  const result = readDesignRecord(bytes, reference);
  expect(result.kind).toBe('typed');
  if (result.kind !== 'typed') throw new Error(JSON.stringify(result));
  return result.snapshot;
}

describe('design record reader', () => {
  it('Read_T01AndT1_PreservesDistinctIds', () => {
    const read = snapshot(fixture);
    expect(read.tasks.map((entry) => entry.id)).toEqual(['T-01', 'T-1']);
    expect(read.tasks[1]!.blockedBy).toEqual(['T-01']);
    expect(read.tasks[0]!.instructions).toBe('Read the record.\nKeep its original bytes.');
    expect(read.definitions.map((entry) => entry.id)).toEqual(['DR-1', 'DR-2']);
    expect(read.reference).toBe(reference);
    expect(read.digest).toBe(createHash('sha256').update(fixture).digest('hex'));
    expect(Buffer.from(read.rawBytes)).toEqual(fixture);
  });

  it('Read_EquivalentEscapedDuplicateKeys_Refuses', () => {
    const body = JSON.stringify(plan).replace('"version":1', '"version":1,"ver\\u0073ion":1');
    expect(readDesignRecord(record(body), reference)).toMatchObject({ kind: 'invalid', message: 'Duplicate JSON key: version' });
    const nested = JSON.stringify(plan).replace('"id":"T-01"', '"id":"T-01","\\u0069d":"T-01"');
    expect(readDesignRecord(record(nested), reference)).toMatchObject({ kind: 'invalid', message: 'Duplicate JSON key: id' });
  });

  it('Read_NestedFenceExample_IsNotPlan', () => {
    for (const outer of ['````', '~~~~']) {
      const example = Buffer.from(`${outer}markdown\n${record(JSON.stringify(plan))}${outer}\n`);
      expect(readDesignRecord(example, reference).kind).toBe('legacy');
      expect(snapshot(Buffer.concat([example, record(JSON.stringify(plan))])).tasks).toHaveLength(1);
    }
  });

  it('ignores list, blockquote and indented code examples', () => {
    const source = record(JSON.stringify(plan)).toString();
    for (const example of [source.replace(/^/gm, '    '), source.replace(/^/gm, '> '),
      '- Example:\n\n' + source.replace(/^/gm, '  '), '- ```exarchos-plan-v1\n  {}\n  ```\n']) {
      expect(readDesignRecord(Buffer.from(example), reference).kind).toBe('legacy');
      expect(snapshot(Buffer.from(example + '\n' + source)).tasks).toHaveLength(1);
    }
  });

  it('ends a list fence at container exit before reading a top-level plan', () => {
    for (const prefix of ['- ```text\n  Example\n\n', '1. ~~~text\n   Example\n', '- Example\n\n  ```text\n  Example\n']) {
      expect(readDesignRecord(Buffer.from(prefix + record('{').toString()), reference).kind).toBe('invalid');
      expect(snapshot(Buffer.from(prefix + record(JSON.stringify(plan)).toString())).tasks[0]!.id).toBe('T-01');
    }
  });

  it('excludes all HTML block forms from plan and requirement authority', () => {
    const wrappers = [['<!--', '-->'], ['<script>', '</STYLE>'], ['<?processing', '?>'],
      ['<!DECLARATION', '>'], ['<![CDATA[', ']]>'], ['<div class=', '\n'], ['<custom data-x="a">', '\n']];
    for (const [open, close] of wrappers) {
      const fenced = '```exarchos-plan-v1\n' + JSON.stringify(plan) + '\n```\n';
      expect(readDesignRecord(Buffer.from(open + '\n' + fenced + close + '\n'), reference).kind).toBe('legacy');
      const source = '## Design & Rationale\n### DR-1: Real\n\n' + open + '\n### DR-99: Hidden\n## Appendix\n' + close
        + '\n### DR-2: Real\n\n' + fenced;
      expect(snapshot(Buffer.from(source)).definitions.map(({ id }) => id)).toEqual(['DR-1', 'DR-2']);
    }
  });

  it('resumes Markdown at HTML block endings and container exits', () => {
    const fenced = '```exarchos-plan-v1\n' + JSON.stringify(plan) + '\n```\n';
    for (const prefix of ['<!-- same line -->\n', '<div></div>\n\n', '<custom />\n\n', '<pre/>\n', '<SCRIPT/>\n', '<div/invalid\n',
      '- <!--\n  Hidden\n', '- <div>\n  Hidden\n', '> <!--\n> Hidden\n']) {
      expect(snapshot(Buffer.from(prefix + fenced)).tasks[0]!.id).toBe('T-01');
    }
    expect(snapshot(Buffer.from('Paragraph\n<custom>\n' + fenced)).tasks[0]!.id).toBe('T-01');
    expect(snapshot(Buffer.from('````text\n<!--\n````\n' + fenced)).tasks[0]!.id).toBe('T-01');
    expect(readDesignRecord(Buffer.from('<!--\n\n' + fenced), reference).kind).toBe('legacy');
    expect(readDesignRecord(Buffer.from('<div>\n' + fenced), reference).kind).toBe('legacy');
  });

  it('refuses a task without its required test layer', () => {
    const { testLayer, ...withoutLayer } = task;
    expect(testLayer).toBe('unit');
    expect(readDesignRecord(record(JSON.stringify({ ...plan, tasks: [withoutLayer] })), reference).kind).toBe('invalid');
  });

  it('Read_InvalidUtf8_Refuses', () => {
    for (const bytes of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x9f], [0xff]]) {
      expect(readDesignRecord(Buffer.concat([fixture, Buffer.from(bytes)]), reference).kind).toBe('invalid');
    }
  });

  it.each(['version: 1', '{"version":1,}', '{"version":NaN}', '{"version":1 // comment\n}', '{', '']) (
    'Read_MalformedTypedBlock_NeverLegacy: %s', (body) => {
      expect(readDesignRecord(record(body), reference).kind).toBe('invalid');
    },
  );

  it('refuses ambiguous, unsupported and unterminated typed blocks', () => {
    expect(readDesignRecord(Buffer.concat([fixture, fixture]), reference).kind).toBe('invalid');
    for (const info of ['exarchos-plan-v2', 'exarchos-plan-v1 extra', 'exarchos-plan']) {
      expect(readDesignRecord(record(JSON.stringify(plan), '```', info), reference).kind).toBe('invalid');
    }
    expect(readDesignRecord(record(JSON.stringify({ ...plan, version: 2 })), reference).kind).toBe('invalid');
    expect(readDesignRecord(Buffer.from('```exarchos-plan-v1\n{}'), reference).kind).toBe('invalid');
    expect(readDesignRecord(Buffer.from('~~~exarchos-plan-v1\n{}\n```\n'), reference).kind).toBe('invalid');
  });

  it('retains spans across Unicode and CRLF without normalizing the digest', () => {
    const variants = [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture]), fixture, Buffer.from(fixture.toString().replaceAll('\n', '\r\n')), Buffer.concat([fixture, Buffer.from(' ')])];
    const reads = variants.map(snapshot);
    expect(new Set(reads.map((read) => read.digest)).size).toBe(4);
    for (const [index, read] of reads.entries()) {
      const source = variants[index]!.toString();
      expect(JSON.parse(source.slice(read.planSpan.start, read.planSpan.end)).tasks).toHaveLength(2);
      for (const entry of read.tasks) {
        expect(JSON.parse(source.slice(entry.span.start, entry.span.end)).id).toBe(entry.id);
        expect(source.slice(0, entry.span.start).split('\n')).toHaveLength(entry.span.startLine);
      }
      for (const definition of read.definitions) {
        expect(source.slice(definition.span.start, definition.span.end)).toBe(`### ${definition.title}`);
      }
    }
  });

  it('recognizes setext requirements and ignores headings outside their region', () => {
    const source = Buffer.from('Design & Rationale\n==================\nDR-1: Source\n------------\n\nAppendix\n========\nDR-9: Example\n-------------\n' + record(JSON.stringify(plan)).toString().split('```')[1]!.replace(/^exarchos/, '```exarchos') + '```\n');
    const read = snapshot(source);
    expect(read.definitions.map((entry) => entry.id)).toEqual(['DR-1']);
    expect(source.toString().slice(read.definitions[0]!.span.start, read.definitions[0]!.span.end)).toBe('DR-1: Source\n------------');
  });

  it('owns frozen bytes and deeply frozen task arrays', () => {
    const bytes = Buffer.from(fixture);
    const read = snapshot(bytes);
    bytes.fill(0);
    expect(Buffer.from(read.rawBytes)).toEqual(fixture);
    expect(() => (read.rawBytes as number[]).fill(0)).toThrow();
    expect(() => (read.tasks[1]!.blockedBy as string[]).push('T-99')).toThrow();
    expect(Object.isFrozen(read.tasks[0]!.span)).toBe(true);
    expect(Object.isFrozen(read.definitions[0])).toBe(true);
    expect(Object.isFrozen(read)).toBe(true);
  });

  it.each([
    { title: '' }, { instructions: ' ' }, { acceptance: [] }, { files: [] }, { riskTier: 'critical' },
    { boundaryTouching: 'false' }, { parallelizable: 1 }, { testLayer: 'e2e' }, { extra: true },
    { id: '/task' }, { implements: ['DR-01'] }, { implements: ['DR-1', 'DR-1'] },
    { blockedBy: ['T-1', 'T-1'] }, { files: ['docs/a', 'docs/a'] }, { riskTier: 'high', testFiles: [] },
    { files: ['/etc/passwd'] }, { files: ['../a'] }, { files: ['a/../b'] }, { files: ['a\0b'] },
    { files: ['C:/a'] }, { files: ['a\\b'] }, { testFiles: ['../bad'] },
  ])('refuses invalid task structure %j', (change) => {
    expect(readDesignRecord(record(JSON.stringify({ ...plan, tasks: [{ ...task, ...change }] })), reference).kind).toBe('invalid');
  });

  it('requires all task keys except testLayer and closes the root keys', () => {
    expect(snapshot(record(JSON.stringify({ ...plan, tasks: [{ ...task, implements: [], files: ['./docs/plan.md', 'docs//other.md'] }] }))).tasks[0]!.files).toEqual(['./docs/plan.md', 'docs//other.md']);
    for (const key of Object.keys(task).filter((key) => key !== 'testLayer')) {
      const changed: Record<string, unknown> = { ...task };
      delete changed[key];
      expect(readDesignRecord(record(JSON.stringify({ ...plan, tasks: [changed] })), reference).kind).toBe('invalid');
    }
    for (const changed of [{ ...plan, extra: true }, { ...plan, requirements: [] }, { ...plan, tasks: [] },
      { ...plan, requirements: ['DR-1', 'DR-1'] }, { ...plan, tasks: [task, task] }]) {
      expect(readDesignRecord(record(JSON.stringify(changed)), reference).kind).toBe('invalid');
    }
  });

  it('enforces exact byte and depth limits and explicit overrides', () => {
    expect(readDesignRecord(fixture, reference, { maxBytes: fixture.length }).kind).toBe('typed');
    expect(readDesignRecord(fixture, reference, { maxBytes: fixture.length - 1 }).kind).toBe('invalid');
    expect(readDesignRecord(fixture, reference, { maxDepth: 4 }).kind).toBe('typed');
    expect(readDesignRecord(fixture, reference, { maxDepth: 3 }).kind).toBe('invalid');
    expect(readDesignRecord(Buffer.alloc(1024 * 1024 + 1, 32), reference).kind).toBe('invalid');
    expect(readDesignRecord(Buffer.alloc(1024 * 1024 + 1, 32), reference, { maxBytes: 1024 * 1024 + 1 }).kind).toBe('legacy');
    expect(readDesignRecord(record('['.repeat(129) + '0' + ']'.repeat(129)), reference)).toMatchObject({ kind: 'invalid', message: 'Plan exceeds the JSON depth limit' });
  });

  it('reads a mounted reference once and rejects lexical escape or missing files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'design-reader-'));
    try {
      await symlink(path.dirname(fixturePath), path.join(root, 'docs'), 'dir');
      const mounted = await readDesignRecordAt(root, 'docs/typed-standard.md');
      expect(mounted.kind).toBe('typed');
      if (mounted.kind !== 'typed') throw new Error('Missing mounted snapshot');
      expect(Buffer.from(mounted.snapshot.rawBytes)).toEqual(fixture);
      await writeFile(path.join(root, 'local.md'), fixture);
      expect((await readDesignRecordAt(root, 'local.md', { maxBytes: fixture.length })).kind).toBe('typed');
      expect((await readDesignRecordAt(root, 'local.md', { maxBytes: fixture.length - 1 })).kind).toBe('invalid');
      expect((await readDesignRecordAt(root, '../outside.md')).kind).toBe('invalid');
      expect((await readDesignRecordAt(root, 'absent.md')).kind).toBe('invalid');
      expect((await readDesignRecordAt(root, root)).kind).toBe('invalid');
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('preserves generated exact IDs and edges', () => {
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 99999 }), { minLength: 1, maxLength: 20 }), (ids) => {
      const tasks = ids.map((id, index) => ({ ...task, id: `t-${'0'.repeat(index % 3)}${id}`,
        blockedBy: ids.slice(0, index).map((prior, i) => `t-${'0'.repeat(i % 3)}${prior}`) }));
      const read = snapshot(record(JSON.stringify({ ...plan, tasks })));
      expect(read.tasks.map(({ id, blockedBy }) => ({ id, blockedBy }))).toEqual(tasks.map(({ id, blockedBy }) => ({ id, blockedBy })));
    }), { numRuns: 100, seed: 192701 });
  });

  it('refuses generated escape-equivalent duplicate keys', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 6 }), (index) => {
      const key = 'version';
      const escaped = key.slice(0, index) + '\\u' + key.charCodeAt(index).toString(16).padStart(4, '0') + key.slice(index + 1);
      const body = JSON.stringify(plan).replace('"version":1', `"version":1,"${escaped}":1`);
      expect(readDesignRecord(record(body), reference)).toMatchObject({ kind: 'invalid', message: 'Duplicate JSON key: version' });
    }), { numRuns: 100, seed: 192702 });
  });
});
