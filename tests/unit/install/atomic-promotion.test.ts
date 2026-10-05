/**
 * Tests for the staged, atomic promotion of a multi-file tree. They run on the real filesystem
 * and force failures through the {@link PromotionIo} seam at these stages:
 *
 *   - mid-stage: a file write fails before the stage is complete
 *   - stage-verify: the engine rejects a corrupt stage before the promotion
 *   - start of promotion: the rename of `target` to the backup fails
 *   - mid-promotion: the rename of the staging directory to `target` fails
 *   - hard crash: the mid-promotion rename and the rollback restore both fail
 *   - finalize: the removal of the backup after the commit fails
 *
 * After each failure, the destination must be the complete old tree or the complete new tree,
 * by {@link digestTree}. A retry must converge, and a dry run must change nothing.
 */

import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir, rmrf } from '../../../tools/test-helpers/temp-dir.js';
import { digestTree, type DigestEntry } from '../../../src/install/install-identity.js';
import { DRY_RUN, LIVE, isDryRun, isError, isSuccess } from '../../../src/dispatch/core/effect-carrier.js';
import {
  PROMOTION_EXECUTED,
  PromotionError,
  atomicCopyTreeSync,
  defaultPromotionIo,
  promoteTree,
  promoteTreeSync,
  promotionPlan,
  recoverInterruptedPromotion,
  type PromotionExecutedRecord,
  type PromotionIo,
  type PromotionRecorder,
} from '../../../src/install/atomic-promotion.js';
import { PromotionExecutedData } from '../../../src/events/schemas.js';

const OLD_TREE: DigestEntry[] = [
  { path: 'a.md', content: 'OLD alpha\n' },
  { path: 'nested/b.md', content: 'OLD beta\n' },
  { path: 'nested/deep/c.md', content: 'OLD gamma\n' },
];

/** Compared with `OLD_TREE`, this tree has no `nested/deep/c.md` and adds `d.md`. */
const NEW_TREE: DigestEntry[] = [
  { path: 'a.md', content: 'NEW alpha (rewritten)\n' },
  { path: 'nested/b.md', content: 'NEW beta (rewritten)\n' },
  { path: 'd.md', content: 'NEW delta (added)\n' },
];

/** Materialize a tree on disk under `dir`. */
function writeTree(dir: string, entries: readonly DigestEntry[]): void {
  for (const entry of entries) {
    const full = path.join(dir, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, entry.content, 'utf8');
  }
}

/** Read a tree off disk into content entries (recursive). */
function readTree(dir: string): DigestEntry[] {
  if (!fs.existsSync(dir)) return [];
  const out: DigestEntry[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const dirent of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory()) walk(path.join(d, dirent.name), rel);
      else if (dirent.isFile()) out.push({ path: rel, content: fs.readFileSync(path.join(d, dirent.name), 'utf8') });
    }
  };
  walk(dir, '');
  return out;
}

/** Digest of the tree currently on disk at `dir` (`sha256:…` or `<absent>`). */
function diskDigest(dir: string): string {
  return fs.existsSync(dir) ? digestTree(readTree(dir)) : '<absent>';
}

/**
 * Wrap a base IO so that `hook` runs before each operation. A `hook` that throws faults that
 * operation before the real write or rename occurs.
 */
function wrapIo(
  base: PromotionIo,
  hook: (op: keyof PromotionIo, first: string, second?: string) => void,
): PromotionIo {
  return {
    mkdirp: (d) => { hook('mkdirp', d); base.mkdirp(d); },
    writeFile: (f, data) => { hook('writeFile', f); base.writeFile(f, data); },
    readFile: (f) => { hook('readFile', f); return base.readFile(f); },
    listTree: (d) => { hook('listTree', d); return base.listTree(d); },
    exists: (t) => { hook('exists', t); return base.exists(t); },
    rename: (from, to) => { hook('rename', from, to); base.rename(from, to); },
    removeTree: (t) => { hook('removeTree', t); base.removeTree(t); },
  };
}

class InjectedFault extends Error {}

let root: string;
let target: string;
const OLD_DIGEST = digestTree(OLD_TREE);
const NEW_DIGEST = digestTree(NEW_TREE);

beforeEach(() => {
  root = makeTempDir('exarchos-promote-');
  target = path.join(root, 'skills');
});

afterEach(() => {
  rmrf(root);
});

/** Absolute path of a scaffolding dir/file for the current `target`. */
const stageDir = () => path.join(root, '.skills.exarchos-stage');
const backupDir = () => path.join(root, '.skills.exarchos-backup');
const journalFile = () => path.join(root, '.skills.exarchos-promote.json');

/** Assert no promotion scaffolding lingers after a converged run. */
function expectNoScaffolding(): void {
  expect(fs.existsSync(stageDir())).toBe(false);
  expect(fs.existsSync(backupDir())).toBe(false);
  expect(fs.existsSync(journalFile())).toBe(false);
}

describe('promoteTreeSync — happy path', () => {
  it('promotes a new tree into an ABSENT target and leaves no scaffolding', () => {
    const report = promoteTreeSync({ target, entries: NEW_TREE });
    expect(report.promoted).toBe(true);
    expect(report.treeDigest).toBe(NEW_DIGEST);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expectNoScaffolding();
  });

  /** The swap replaces the full tree and does not merge: `c.md` is absent and `d.md` is present. */
  it('replaces an EXISTING old tree with the new tree, whole', () => {
    writeTree(target, OLD_TREE);
    expect(diskDigest(target)).toBe(OLD_DIGEST);

    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(path.join(target, 'nested', 'deep', 'c.md'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'd.md'))).toBe(true);
    expectNoScaffolding();
  });

  it('is idempotent: promoting the same tree twice is a converged no-op', () => {
    promoteTreeSync({ target, entries: NEW_TREE });
    const second = promoteTreeSync({ target, entries: NEW_TREE });
    expect(second.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expectNoScaffolding();
  });
});

describe('promoteTreeSync — fault injection leaves no torn state', () => {
  /** The second staged write fails. The destination stays the complete old tree, and the engine removes the partial stage. */
  it('FAULT mid-stage: target stays fully OLD; retry converges to NEW', () => {
    writeTree(target, OLD_TREE);
    let writes = 0;
    const io = wrapIo(defaultPromotionIo(), (op, first) => {
      if (op === 'writeFile' && first.includes('.exarchos-stage')) {
        writes += 1;
        if (writes === 2) throw new InjectedFault('mid-stage write failed');
      }
    });

    expect(() => promoteTreeSync({ target, entries: NEW_TREE }, io)).toThrow(PromotionError);
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expect(fs.existsSync(stageDir())).toBe(false);

    const report = promoteTreeSync({ target, entries: NEW_TREE });
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(report.promoted).toBe(true);
    expectNoScaffolding();
  });

  /** The IO writes different bytes for `a.md`, so the staged digest does not match the request. */
  it('FAULT stage-verify: a corrupt stage is rejected before any promote (target OLD)', () => {
    writeTree(target, OLD_TREE);
    const io = wrapIo(defaultPromotionIo(), () => {});
    const corrupting: PromotionIo = {
      ...io,
      writeFile: (f, data) => {
        const bytes = f.endsWith('a.md') ? Buffer.from('TRUNCATED', 'utf8') : data;
        io.writeFile(f, bytes);
      },
    };

    const err = (() => {
      try {
        promoteTreeSync({ target, entries: NEW_TREE }, corrupting);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('STAGE_INCOMPLETE');
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expect(fs.existsSync(stageDir())).toBe(false);
  });

  it('FAULT after-stage (target→backup rename): target stays fully OLD; retry converges', () => {
    writeTree(target, OLD_TREE);
    const io = wrapIo(defaultPromotionIo(), (op, _from, to) => {
      if (op === 'rename' && to?.includes('.exarchos-backup')) {
        throw new InjectedFault('backup rename failed');
      }
    });

    expect(() => promoteTreeSync({ target, entries: NEW_TREE }, io)).toThrow(PromotionError);
    expect(diskDigest(target)).toBe(OLD_DIGEST);

    const report = promoteTreeSync({ target, entries: NEW_TREE });
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(report.promoted).toBe(true);
    expectNoScaffolding();
  });

  /**
   * The in-line rollback restores the old tree and removes the scaffolding. Thus the retry has
   * no prior attempt to recover.
   */
  it('FAULT mid-promote (staging→target rename): in-line rollback restores fully OLD', () => {
    writeTree(target, OLD_TREE);
    const io = wrapIo(defaultPromotionIo(), (op, from) => {
      if (op === 'rename' && from.includes('.exarchos-stage')) {
        throw new InjectedFault('promote rename failed');
      }
    });

    expect(() => promoteTreeSync({ target, entries: NEW_TREE }, io)).toThrow(PromotionError);
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expectNoScaffolding();

    const report = promoteTreeSync({ target, entries: NEW_TREE });
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(report.recoveredPriorAttempt).toBe(false);
    expectNoScaffolding();
  });

  /**
   * A cleanup fault after the commit point does not fail the promotion. The backup stays
   * beside a complete new tree, and the next run removes it.
   */
  it('FAULT finalize (backup cleanup after commit): destination is fully NEW', () => {
    writeTree(target, OLD_TREE);
    const io = wrapIo(defaultPromotionIo(), (op, first) => {
      if (op === 'removeTree' && first.includes('.exarchos-backup')) {
        throw new InjectedFault('backup cleanup failed');
      }
    });

    const report = promoteTreeSync({ target, entries: NEW_TREE }, io);
    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);

    const cleaned = promoteTreeSync({ target, entries: NEW_TREE });
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(cleaned.promoted).toBe(true);
    expectNoScaffolding();
  });
});

/**
 * An entry path is caller data, and it must not escape the staging directory. The engine checks
 * each path component with the guard of the artifact store. A violation throws the typed
 * error of the module, and the engine writes no byte of that entry.
 */
describe('promoteTreeSync — staging containment', () => {
  /**
   * Without the guard, `../escape.txt` lands at `escape.txt` in the parent of `target`. A
   * containment violation is a stage failure, so `target` stays the old tree.
   */
  it('a `..` entry path is rejected typed and writes NOTHING outside the staging dir', () => {
    writeTree(target, OLD_TREE);
    const escapeLanding = path.join(root, 'escape.txt');

    const err = (() => {
      try {
        promoteTreeSync({
          target,
          entries: [...NEW_TREE, { path: '../escape.txt', content: 'ESCAPED\n' }],
        });
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('STAGE_INCOMPLETE');
    expect(
      fs.existsSync(escapeLanding),
      'a traversal entry must not write outside the staging dir',
    ).toBe(false);
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expect(fs.existsSync(stageDir())).toBe(false);
  });

  it('an absolute entry path is rejected typed before any byte is staged', () => {
    writeTree(target, OLD_TREE);

    const err = (() => {
      try {
        promoteTreeSync({
          target,
          entries: [{ path: '/abs/escape.txt', content: 'ESCAPED\n' }],
        });
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('STAGE_INCOMPLETE');
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expect(fs.existsSync(stageDir())).toBe(false);
  });
});

describe('promoteTreeSync — hard crash + idempotent recovery (EFF-012)', () => {
  /**
   * Faults the commit rename and the rollback restore, as a process kill during the promotion
   * does. Then `target` is absent, the backup holds the complete old tree, and the journal
   * stays. A retry recovers the old tree and then promotes the new tree.
   */
  it('double fault (promote AND rollback) leaves the OLD tree recoverable; retry converges', () => {
    writeTree(target, OLD_TREE);
    const io = wrapIo(defaultPromotionIo(), (op, from) => {
      if (op === 'rename' && from.includes('.exarchos-stage')) throw new InjectedFault('commit killed');
      if (op === 'rename' && from.includes('.exarchos-backup')) throw new InjectedFault('rollback killed');
    });

    expect(() => promoteTreeSync({ target, entries: NEW_TREE }, io)).toThrow(PromotionError);

    expect(fs.existsSync(target)).toBe(false);
    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
    expect(fs.existsSync(journalFile())).toBe(true);

    const report = promoteTreeSync({ target, entries: NEW_TREE });
    expect(report.recoveredPriorAttempt).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expectNoScaffolding();
  });

  /** Recovery alone restores the complete old tree. A second recovery finds no journal and returns `false`. */
  it('recoverInterruptedPromotion alone restores the OLD tree after a crash (no re-promote)', () => {
    writeTree(target, OLD_TREE);
    const io = wrapIo(defaultPromotionIo(), (op, from) => {
      if (op === 'rename' && from.includes('.exarchos-stage')) throw new InjectedFault('commit killed');
      if (op === 'rename' && from.includes('.exarchos-backup')) throw new InjectedFault('rollback killed');
    });
    expect(() => promoteTreeSync({ target, entries: NEW_TREE }, io)).toThrow(PromotionError);
    expect(fs.existsSync(target)).toBe(false);

    const recovered = recoverInterruptedPromotion(target);
    expect(recovered).toBe(true);
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expectNoScaffolding();

    expect(recoverInterruptedPromotion(target)).toBe(false);
  });
});

/**
 * `collectingRecorder` is a stand-in for the durable store that a production caller supplies.
 * It keeps each record in call order.
 */
describe('promoteTree — effect carrier', () => {
  function collectingRecorder(): {
    recorder: (record: PromotionExecutedRecord) => void;
    records: PromotionExecutedRecord[];
  } {
    const records: PromotionExecutedRecord[] = [];
    return {
      recorder: (record) => {
        records.push(record);
      },
      records,
    };
  }

  /** The IO seam gets no call, the target does not change, and the recorder gets no record. */
  it('dry-run performs NO promotion, returns the withheld plan, and records NOTHING', async () => {
    writeTree(target, OLD_TREE);
    let touched = false;
    const io = wrapIo(defaultPromotionIo(), () => { touched = true; });
    const { recorder, records } = collectingRecorder();

    const outcome = await promoteTree({ target, entries: NEW_TREE }, DRY_RUN, io, recorder);

    expect(isDryRun(outcome)).toBe(true);
    if (isDryRun(outcome)) {
      expect(outcome.plan.effectClass).toBe('install');
      expect(outcome.plan.idempotent).toBe(true);
      expect(outcome.plan.compensation).toContain('roll back');
    }
    expect(touched).toBe(false);
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expectNoScaffolding();
    expect(records).toEqual([]);
  });

  it('live success returns a success carrier with the promotion report', async () => {
    const { recorder } = collectingRecorder();
    const outcome = await promoteTree({ target, entries: NEW_TREE }, LIVE, defaultPromotionIo(), recorder);
    expect(isSuccess(outcome)).toBe(true);
    if (isSuccess(outcome)) {
      expect(outcome.value.promoted).toBe(true);
      expect(outcome.value.treeDigest).toBe(NEW_DIGEST);
    }
    expect(diskDigest(target)).toBe(NEW_DIGEST);
  });

  /**
   * The engine rolls back to the complete old tree. A rollback records nothing, because the
   * plan declares only a success emission.
   */
  it('live failure is captured into a structured error carrier (no throw)', async () => {
    writeTree(target, OLD_TREE);
    const io = wrapIo(defaultPromotionIo(), (op, from) => {
      if (op === 'rename' && from.includes('.exarchos-stage')) throw new InjectedFault('boom');
    });
    const { recorder, records } = collectingRecorder();
    const outcome = await promoteTree({ target, entries: NEW_TREE }, LIVE, io, recorder);
    expect(isError(outcome)).toBe(true);
    if (isError(outcome)) {
      expect(outcome.error.code).toBe('INSTALL_EFFECT_FAILED');
      expect(typeof outcome.error.message).toBe('string');
    }
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expect(records).toEqual([]);
  });

  /**
   * The recorder blocks, so the test can see whether the promotion promise settles while its
   * record is in flight. A fire-and-forget append lets the promise settle first. One log gets
   * an entry from the recorder and an entry from the promise continuation, so it gives their
   * order. The two event-loop turns after `entered` give an early settle the time to show.
   * The record must parse with the catalog schema, and its owner must be the plan owner.
   */
  it('PromoteTree_LiveMode_CommitsItsEventBeforeReturning', async () => {
    let releaseRecorder!: () => void;
    let recorderEntered!: () => void;
    const held = new Promise<void>((resolve) => { releaseRecorder = resolve; });
    const entered = new Promise<void>((resolve) => { recorderEntered = resolve; });

    const order: string[] = [];
    const recorded: PromotionExecutedRecord[] = [];

    const settling = promoteTree(
      { target, entries: NEW_TREE },
      LIVE,
      defaultPromotionIo(),
      async (record) => {
        recorderEntered();
        await held;
        recorded.push(record);
        order.push('committed');
      },
    ).then((outcome) => {
      order.push('returned');
      return outcome;
    });

    await entered;
    await new Promise((resolve) => { setImmediate(resolve); });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(order, 'the promotion returned while its record was still in flight').toEqual([]);

    releaseRecorder();
    const outcome = await settling;

    expect(order).toEqual(['committed', 'returned']);
    expect(isSuccess(outcome)).toBe(true);

    expect(recorded).toHaveLength(1);
    const record = recorded[0];
    expect(PromotionExecutedData.parse(record)).toEqual(record);
    expect(record?.target).toBe(target);
    expect(record?.treeDigest).toBe(NEW_DIGEST);
    expect(record?.recoveredPriorAttempt).toBe(false);
    expect(record?.owner).toBe(promotionPlan('install/atomic-promotion', target).owner);
    expect(promotionPlan('install/atomic-promotion', target).emits).toEqual({
      kind: 'records',
      emissions: [{ event: PROMOTION_EXECUTED, when: 'on-success' }],
    });
    expect(diskDigest(target)).toBe(NEW_DIGEST);
  });

  /**
   * The plan declares an emission, so a live call with no recorder throws before any IO. The
   * refusal is a throw and not an error carrier, because a missing recorder is a wiring fault
   * in the caller. `promoteTree` makes the check itself. The carrier sees a wrapper around the
   * recorder, so its own check fires only after the tree moves.
   */
  it('PromoteTree_LiveModeWithNoRecorder_RefusesBeforeTouchingTheTree', async () => {
    writeTree(target, OLD_TREE);
    let touched = false;
    const io = wrapIo(defaultPromotionIo(), () => { touched = true; });

    await expect(
      promoteTree(
        { target, entries: NEW_TREE },
        LIVE,
        io,
        undefined as unknown as PromotionRecorder,
      ),
    ).rejects.toThrow(/requires a recorder|EMISSION_NOT_RECORDED/);

    expect(touched).toBe(false);
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expectNoScaffolding();
  });
});

describe('promoted tree is content-faithful (projection-containment present)', () => {
  /**
   * The promoted tree gives the same content digest as the source entries. A changed byte at
   * the same path changes the digest.
   */
  it('every source projection is present with a byte-faithful digest after promotion', () => {
    const skills: DigestEntry[] = [
      { path: 'claude/planning/SKILL.md', content: '# planning\nbody\n' },
      { path: 'claude/planning/examples.md', content: 'example\n' },
      { path: 'claude/review/SKILL.md', content: '# review\nbody\n' },
    ];
    promoteTreeSync({ target, entries: skills });

    expect(digestTree(readTree(target))).toBe(digestTree(skills));
    for (const entry of skills) {
      const onDisk = fs.readFileSync(path.join(target, ...entry.path.split('/')), 'utf8');
      expect(onDisk).toBe(entry.content);
    }
  });
});

describe('atomicCopyTreeSync — the atomic copyDir seam', () => {
  it('copies a source dir into an absent dest, whole', () => {
    const src = path.join(root, 'src-tree');
    writeTree(src, NEW_TREE);
    const dest = path.join(root, 'dest');
    atomicCopyTreeSync(src, dest);
    expect(digestTree(readTree(dest))).toBe(digestTree(readTree(src)));
  });

  it('a mid-copy failure leaves dest ABSENT (never half-populated); retry converges', () => {
    const src = path.join(root, 'src-tree');
    writeTree(src, NEW_TREE);
    const dest = path.join(root, 'dest');
    let writes = 0;
    const io = wrapIo(defaultPromotionIo(), (op, first) => {
      if (op === 'writeFile' && first.includes('.exarchos-stage')) {
        writes += 1;
        if (writes === 2) throw new InjectedFault('copy killed mid-stage');
      }
    });
    expect(() => atomicCopyTreeSync(src, dest, io)).toThrow(PromotionError);
    expect(fs.existsSync(dest)).toBe(false);

    atomicCopyTreeSync(src, dest);
    expect(digestTree(readTree(dest))).toBe(digestTree(readTree(src)));
  });
});

/** Return the sorted `name` of each runtime YAML file in `content/harness/runtimes`. */
function declaredRuntimes(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runtimesDir = path.resolve(here, '../../../content/harness/runtimes');
  const names: string[] = [];
  for (const file of fs.readdirSync(runtimesDir)) {
    if (!file.endsWith('.yaml')) continue;
    const text = fs.readFileSync(path.join(runtimesDir, file), 'utf8');
    const match = /^name:\s*(\S+)\s*$/m.exec(text);
    if (match?.[1]) names.push(match[1]);
  }
  return names.sort();
}

describe('EFF-012 — onboarding install converges per supported runtime', () => {
  const runtimes = declaredRuntimes();

  /** Without this check, the loop below can run for zero runtimes and pass. */
  it('discovers the supported runtimes from content/harness/runtimes/*.yaml', () => {
    expect(runtimes).toEqual(
      expect.arrayContaining(['claude', 'codex', 'copilot', 'cursor', 'generic', 'opencode']),
    );
  });

  for (const runtime of runtimes) {
    /**
     * Models the skill tree of one runtime that the onboarding install promotes. The first run
     * fails at the swap rename and must leave the complete old tree. The second run converges
     * to the new tree, and a third run changes nothing.
     */
    it(`[${runtime}] a failed install rolls back to OLD, and re-running converges to NEW`, () => {
      const runtimeDir = path.join(root, 'skills', runtime);
      const oldTree: DigestEntry[] = [
        { path: 'planning/SKILL.md', content: `# planning (${runtime})\nOLD\n` },
        { path: 'review/SKILL.md', content: `# review (${runtime})\nOLD\n` },
      ];
      const newTree: DigestEntry[] = [
        { path: 'planning/SKILL.md', content: `# planning (${runtime})\nNEW\n` },
        { path: 'implement/SKILL.md', content: `# implement (${runtime})\nNEW\n` },
      ];
      const oldDigest = digestTree(oldTree);
      const newDigest = digestTree(newTree);
      writeTree(runtimeDir, oldTree);

      const io = wrapIo(defaultPromotionIo(), (op, from) => {
        if (op === 'rename' && from.includes('.exarchos-stage')) {
          throw new InjectedFault(`[${runtime}] install interrupted mid-promote`);
        }
      });
      expect(() => promoteTreeSync({ target: runtimeDir, entries: newTree }, io)).toThrow(PromotionError);

      expect(digestTree(readTree(runtimeDir))).toBe(oldDigest);

      const report = promoteTreeSync({ target: runtimeDir, entries: newTree });
      expect(report.promoted).toBe(true);
      expect(digestTree(readTree(runtimeDir))).toBe(newDigest);

      promoteTreeSync({ target: runtimeDir, entries: newTree });
      expect(digestTree(readTree(runtimeDir))).toBe(newDigest);
    });
  }
});
