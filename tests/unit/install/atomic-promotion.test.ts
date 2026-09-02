/**
 * atomic-promotion.test.ts — exit-proof tests for staged, atomic, rollback-proof
 * multi-file tree promotion (P04-04; EFF-009, EFF-012).
 *
 * The proofs exercise the promotion on the REAL filesystem (temp dirs) and force
 * failures through the injectable {@link PromotionIo} seam at four distinct
 * stages plus a double-fault "hard crash":
 *
 *   - mid-stage (a file write fails before staging completes),
 *   - stage-verify (a corrupt stage is rejected before any promote),
 *   - after-stage / start-of-promote (the `target → backup` rename fails),
 *   - mid-promote (the `staging → target` rename fails after `target` moved aside),
 *   - hard crash (mid-promote AND the rollback restore also fail).
 *
 * After every injected failure the destination is asserted to be either the
 * COMPLETE old tree or the COMPLETE new tree (verified by {@link digestTree},
 * never by file count), and a retry is asserted to converge. Dry-run is asserted
 * to mutate nothing, and a promoted tree is asserted to be content-faithful
 * (the projection-containment "present" property).
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

// ─── Fixtures + helpers ───────────────────────────────────────────────────────

const OLD_TREE: DigestEntry[] = [
  { path: 'a.md', content: 'OLD alpha\n' },
  { path: 'nested/b.md', content: 'OLD beta\n' },
  { path: 'nested/deep/c.md', content: 'OLD gamma\n' },
];

const NEW_TREE: DigestEntry[] = [
  { path: 'a.md', content: 'NEW alpha (rewritten)\n' },
  { path: 'nested/b.md', content: 'NEW beta (rewritten)\n' },
  { path: 'd.md', content: 'NEW delta (added)\n' }, // c.md removed, d.md added
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
 * Wrap a base IO so `hook` runs BEFORE each delegated operation — a `hook` that
 * throws forces a fault at exactly that operation (before the real write/rename
 * happens, so the failure is genuine).
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

// ─── Happy paths ──────────────────────────────────────────────────────────────

describe('promoteTreeSync — happy path', () => {
  it('promotes a new tree into an ABSENT target and leaves no scaffolding', () => {
    const report = promoteTreeSync({ target, entries: NEW_TREE });
    expect(report.promoted).toBe(true);
    expect(report.treeDigest).toBe(NEW_DIGEST);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expectNoScaffolding();
  });

  it('replaces an EXISTING old tree with the new tree, whole', () => {
    writeTree(target, OLD_TREE);
    expect(diskDigest(target)).toBe(OLD_DIGEST);

    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    // The removed c.md is gone; the added d.md is present — a whole swap, not a merge.
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

// ─── Fault injection: exit-proof (either fully-old or fully-new) ──────────────

describe('promoteTreeSync — fault injection leaves no torn state', () => {
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
    // Exit proof: the destination is the COMPLETE old tree, never a mix.
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expect(fs.existsSync(stageDir())).toBe(false); // partial stage dropped

    // Retry with a clean IO converges to NEW.
    const report = promoteTreeSync({ target, entries: NEW_TREE });
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(report.promoted).toBe(true);
    expectNoScaffolding();
  });

  it('FAULT stage-verify: a corrupt stage is rejected before any promote (target OLD)', () => {
    writeTree(target, OLD_TREE);
    // Corrupt one staged file's bytes so the staged digest disagrees with the request.
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

  it('FAULT mid-promote (staging→target rename): in-line rollback restores fully OLD', () => {
    writeTree(target, OLD_TREE);
    const io = wrapIo(defaultPromotionIo(), (op, from) => {
      if (op === 'rename' && from.includes('.exarchos-stage')) {
        throw new InjectedFault('promote rename failed');
      }
    });

    expect(() => promoteTreeSync({ target, entries: NEW_TREE }, io)).toThrow(PromotionError);
    // The window between the two renames is closed by rollback → fully OLD.
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expectNoScaffolding();

    const report = promoteTreeSync({ target, entries: NEW_TREE });
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(report.recoveredPriorAttempt).toBe(false); // in-line rollback already cleaned up
    expectNoScaffolding();
  });

  it('FAULT finalize (backup cleanup after commit): destination is fully NEW', () => {
    writeTree(target, OLD_TREE);
    const io = wrapIo(defaultPromotionIo(), (op, first) => {
      if (op === 'removeTree' && first.includes('.exarchos-backup')) {
        throw new InjectedFault('backup cleanup failed');
      }
    });

    // Cleanup faults after the commit point are swallowed — the promotion succeeds.
    const report = promoteTreeSync({ target, entries: NEW_TREE }, io);
    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST); // fully NEW

    // A leftover backup is still a fully-NEW destination; recovery/retry cleans it.
    const cleaned = promoteTreeSync({ target, entries: NEW_TREE });
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(cleaned.promoted).toBe(true);
    expectNoScaffolding();
  });
});

// ─── Staging containment: DigestEntry.path may not escape the staging dir ─────
//
// Regression: `stageEntries` used to join `entry.path` under the staging dir
// with no containment validation, so a `..` segment wrote OUTSIDE the staging
// dir (`../escape.txt` landed beside the target's parent). Entry paths are
// caller-supplied data; every component is now validated through the same
// guard the artifact store uses, and a violation fails with the module's
// typed error before any byte is written.

describe('promoteTreeSync — staging containment', () => {
  it('a `..` entry path is rejected typed and writes NOTHING outside the staging dir', () => {
    writeTree(target, OLD_TREE);
    const escapeLanding = path.join(root, 'escape.txt'); // where `../escape.txt` would land

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
    // A containment violation is a stage failure: target fully OLD, stage dropped.
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

// ─── Hard crash (double fault) + journal recovery ────────────────────────────

describe('promoteTreeSync — hard crash + idempotent recovery (EFF-012)', () => {
  it('double fault (promote AND rollback) leaves the OLD tree recoverable; retry converges', () => {
    writeTree(target, OLD_TREE);
    // Fault BOTH the commit rename (staging→target) and the rollback restore
    // (backup→target) — simulating a process kill mid-promote where the in-line
    // rollback cannot complete either.
    const io = wrapIo(defaultPromotionIo(), (op, from) => {
      if (op === 'rename' && from.includes('.exarchos-stage')) throw new InjectedFault('commit killed');
      if (op === 'rename' && from.includes('.exarchos-backup')) throw new InjectedFault('rollback killed');
    });

    expect(() => promoteTreeSync({ target, entries: NEW_TREE }, io)).toThrow(PromotionError);

    // Crash state: target absent, but the COMPLETE old tree survives in backup and
    // the journal records how to finish — nothing is torn, no bytes lost.
    expect(fs.existsSync(target)).toBe(false);
    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
    expect(fs.existsSync(journalFile())).toBe(true);

    // Retry with a clean IO recovers OLD, then promotes NEW — converged.
    const report = promoteTreeSync({ target, entries: NEW_TREE });
    expect(report.recoveredPriorAttempt).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expectNoScaffolding();
  });

  it('recoverInterruptedPromotion alone restores the OLD tree after a crash (no re-promote)', () => {
    writeTree(target, OLD_TREE);
    const io = wrapIo(defaultPromotionIo(), (op, from) => {
      if (op === 'rename' && from.includes('.exarchos-stage')) throw new InjectedFault('commit killed');
      if (op === 'rename' && from.includes('.exarchos-backup')) throw new InjectedFault('rollback killed');
    });
    expect(() => promoteTreeSync({ target, entries: NEW_TREE }, io)).toThrow(PromotionError);
    expect(fs.existsSync(target)).toBe(false);

    // Standalone recovery converges the destination to the COMPLETE old tree.
    const recovered = recoverInterruptedPromotion(target);
    expect(recovered).toBe(true);
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expectNoScaffolding();

    // And a fresh recover on a clean tree is a no-op.
    expect(recoverInterruptedPromotion(target)).toBe(false);
  });
});

// ─── Effect carrier + dry-run (P04-01) ───────────────────────────────────────

describe('promoteTree — effect carrier', () => {
  /**
   * A recorder standing in for the durable store a production caller supplies:
   * it keeps every record it was handed, in the order it was handed them.
   */
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
    // Structurally proven: the IO seam was never touched, and the target is unchanged.
    expect(touched).toBe(false);
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expectNoScaffolding();
    // A withheld effect leaves the ledger as silent as it leaves the disk: the
    // recorder was supplied and still never reached.
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
    // Rolled back to fully OLD despite the failure.
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    // A promotion that rolled back records nothing — there is no success
    // terminal to fire and the plan declares no failure terminal to invent one.
    expect(records).toEqual([]);
  });

  it('PromoteTree_LiveMode_CommitsItsEventBeforeReturning', async () => {
    // "Committed before returning" cannot be observed after the fact: by then
    // "committed first" and "committed at some point" look identical. So the
    // recorder is made to BLOCK, and the question becomes whether the promotion
    // promise can settle while its record is still in flight. If the append
    // were fire-and-forget — or moved after the return — it could, and the
    // assertion below that nothing has settled yet turns red.
    let releaseRecorder!: () => void;
    let recorderEntered!: () => void;
    const held = new Promise<void>((resolve) => { releaseRecorder = resolve; });
    const entered = new Promise<void>((resolve) => { recorderEntered = resolve; });

    // One log, written by both the recorder and the promotion's continuation,
    // so the ORDER of the two is what is being read back — not their presence.
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

    // The recorder is inside its append and has not been let out.
    await entered;
    // Give the promotion every chance to settle early, if it were going to.
    await new Promise((resolve) => { setImmediate(resolve); });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(order, 'the promotion returned while its record was still in flight').toEqual([]);

    releaseRecorder();
    const outcome = await settling;

    // The commit strictly precedes the return, read off ONE ordered log.
    expect(order).toEqual(['committed', 'returned']);
    expect(isSuccess(outcome)).toBe(true);

    // And what was committed is the registered fact, with the payload the
    // catalog's schema demands — read through the schema, not restated.
    expect(recorded).toHaveLength(1);
    const record = recorded[0];
    expect(PromotionExecutedData.parse(record)).toEqual(record);
    expect(record?.target).toBe(target);
    expect(record?.treeDigest).toBe(NEW_DIGEST);
    expect(record?.recoveredPriorAttempt).toBe(false);
    // The owner on the record is the plan's own, so the two cannot drift.
    expect(record?.owner).toBe(promotionPlan('install/atomic-promotion', target).owner);
    // The site declares exactly this name, on success only.
    expect(promotionPlan('install/atomic-promotion', target).emits).toEqual({
      kind: 'records',
      emissions: [{ event: PROMOTION_EXECUTED, when: 'on-success' }],
    });
    // The tree really did land — the record describes a promotion that happened.
    expect(diskDigest(target)).toBe(NEW_DIGEST);
  });

  it('PromoteTree_LiveModeWithNoRecorder_RefusesBeforeTouchingTheTree', async () => {
    writeTree(target, OLD_TREE);
    let touched = false;
    const io = wrapIo(defaultPromotionIo(), () => { touched = true; });

    // The plan declares an emission, so a live call with no capability to
    // record it is refused UP FRONT. The refusal propagates rather than
    // arriving as an error carrier: an unrecordable fact is a wiring fault in
    // the caller, not a failure of the promotion.
    //
    // The refusal now comes from this owner's own guard rather than from the
    // carrier. It has to: the owner WRAPS the caller's recorder in a real
    // capability, so a wrapper around nothing satisfies the carrier's brand
    // check and the refusal would otherwise land at the success terminal —
    // after the tree had moved. The invariant this test exists for is the last
    // two assertions, and they are unchanged.
    await expect(
      promoteTree(
        { target, entries: NEW_TREE },
        LIVE,
        io,
        undefined as unknown as PromotionRecorder,
      ),
    ).rejects.toThrow(/requires a recorder|EMISSION_NOT_RECORDED/);

    // The one thing that must be true of a refusal: nothing moved.
    expect(touched).toBe(false);
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expectNoScaffolding();
  });
});

// ─── Projection-containment "present" property ───────────────────────────────

describe('promoted tree is content-faithful (projection-containment present)', () => {
  it('every source projection is present with a byte-faithful digest after promotion', () => {
    // A skills-shaped tree: skills/<runtime>/<skill>/SKILL.md.
    const skills: DigestEntry[] = [
      { path: 'claude/planning/SKILL.md', content: '# planning\nbody\n' },
      { path: 'claude/planning/examples.md', content: 'example\n' },
      { path: 'claude/review/SKILL.md', content: '# review\nbody\n' },
    ];
    promoteTreeSync({ target, entries: skills });

    // "present": the shipped tree resolves to the SAME content-addressed digest as
    // the authored source — a same-path byte replacement would change the digest.
    expect(digestTree(readTree(target))).toBe(digestTree(skills));
    for (const entry of skills) {
      const onDisk = fs.readFileSync(path.join(target, ...entry.path.split('/')), 'utf8');
      expect(onDisk).toBe(entry.content);
    }
  });
});

// ─── atomicCopyTreeSync (production copyDir seam) ────────────────────────────

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
    // dest never became a torn partial tree.
    expect(fs.existsSync(dest)).toBe(false);

    atomicCopyTreeSync(src, dest);
    expect(digestTree(readTree(dest))).toBe(digestTree(readTree(src)));
  });
});

// ─── EFF-012: idempotent retry + rollback across the supported runtimes ───────

/** Read the declared runtime ids from the repo-root `content/harness/runtimes/*.yaml`. */
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

  it('discovers the supported runtimes from content/harness/runtimes/*.yaml', () => {
    // Guards the loop below against silently testing zero runtimes.
    expect(runtimes).toEqual(
      expect.arrayContaining(['claude', 'codex', 'copilot', 'cursor', 'generic', 'opencode']),
    );
  });

  for (const runtime of runtimes) {
    it(`[${runtime}] a failed install rolls back to OLD, and re-running converges to NEW`, () => {
      // Model the per-runtime skill tree the onboarding install promotes:
      // skills/<runtime>/<skill>/SKILL.md.
      const runtimeDir = path.join(root, 'skills', runtime);
      const oldTree: DigestEntry[] = [
        { path: 'planning/SKILL.md', content: `# planning (${runtime})\nOLD\n` },
        { path: 'review/SKILL.md', content: `# review (${runtime})\nOLD\n` },
      ];
      const newTree: DigestEntry[] = [
        { path: 'planning/SKILL.md', content: `# planning (${runtime})\nNEW\n` },
        { path: 'implement/SKILL.md', content: `# implement (${runtime})\nNEW\n` }, // added
      ];
      const oldDigest = digestTree(oldTree);
      const newDigest = digestTree(newTree);
      writeTree(runtimeDir, oldTree);

      // First run is interrupted mid-promote (process-kill on the swap rename).
      const io = wrapIo(defaultPromotionIo(), (op, from) => {
        if (op === 'rename' && from.includes('.exarchos-stage')) {
          throw new InjectedFault(`[${runtime}] install interrupted mid-promote`);
        }
      });
      expect(() => promoteTreeSync({ target: runtimeDir, entries: newTree }, io)).toThrow(PromotionError);

      // Exit proof: the runtime's skill tree is the COMPLETE old tree, never torn.
      expect(digestTree(readTree(runtimeDir))).toBe(oldDigest);

      // Re-running onboarding install converges to the complete new tree.
      const report = promoteTreeSync({ target: runtimeDir, entries: newTree });
      expect(report.promoted).toBe(true);
      expect(digestTree(readTree(runtimeDir))).toBe(newDigest);

      // A third run is a converged no-op (idempotent).
      promoteTreeSync({ target: runtimeDir, entries: newTree });
      expect(digestTree(readTree(runtimeDir))).toBe(newDigest);
    });
  }
});
