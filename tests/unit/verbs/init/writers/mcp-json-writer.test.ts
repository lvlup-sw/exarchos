/**
 * DR-18 — the spec-named CLI/MCP config writers get the same promotion
 * guarantees the skills tree already had.
 *
 * These are INTEGRATION tests: they run against a real filesystem in a real temp
 * directory, because the property under test — "an injected failure leaves the
 * config old-complete or new-complete" — is a property of renames, fsyncs and
 * journals, and an in-memory fs cannot falsify it. Faults are injected through
 * the writers' own filesystem seams (the `PromotionIo` pattern
 * `install/atomic-promotion.ts` established), never by mocking `node:fs`
 * wholesale.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  McpJsonWriter,
  configPromotionPaths,
  promoteConfigFile,
  recoverInterruptedConfigPromotions,
  type ConfigPromotionFs,
  type McpJsonWriterFs,
} from '../../../../../src/verbs/init/writers/mcp-json-writer.js';
import { CopilotWriter } from '../../../../../src/verbs/init/writers/copilot.js';
import { ClaudeCodeWriter, claudeConfigPath, writeClaudeCode } from '../../../../../src/verbs/init/writers/claude-code.js';
import { makeStubWriterDeps } from '../../../../../src/verbs/init/probes.js';
import type { WriterDeps, WriterFs } from '../../../../../src/verbs/init/probes.js';
import type { WriteOptions } from '../../../../../src/verbs/init/writers/writer.js';
import {
  defaultPromotionIo,
  recoverInterruptedPromotion,
  type PromotionIo,
} from '../../../../../src/install/atomic-promotion.js';
import { fsyncDir, type DirectorySyncOutcome } from '../../../../../src/utils/atomic-write.js';

// ─── Temp-dir plumbing ──────────────────────────────────────────────────────

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-dr18-'));
  tempRoots.push(dir);
  return dir.replace(/\\/g, '/');
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

function defaultOptions(projectRoot: string, overrides?: Partial<WriteOptions>): WriteOptions {
  return { projectRoot, nonInteractive: false, forceOverwrite: false, ...overrides };
}

/** Files a promotion leaves behind if it does not clean up after itself. */
function scaffoldingIn(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((n) => n.includes('exarchos-stage') || n.includes('exarchos-backup') || n.includes('exarchos-promote') || n.endsWith('.tmp'));
}

/** The journal path the promotion writes for `configPath` (and recovery reads). */
function configJournalPath(configPath: string): string {
  return configPromotionPaths(configPath).journalPath;
}

/**
 * True for a write of the STAGED COPY, identified by what it is not (the journal
 * or the backup) rather than by its name — so these tests keep targeting the
 * right step even if the staged copy is renamed, and a probe that reverts the
 * staged copy to a fixed name still exercises the same injection point.
 */
function isStageWrite(p: string): boolean {
  return !p.includes('exarchos-promote') && !p.includes('exarchos-backup');
}

/** The `cause` chain of a wrapped `PromotionError`, flattened to text. */
function causeChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' <- ');
}

// ─── Fault injection ────────────────────────────────────────────────────────

type FsOp = 'readFile' | 'writeFile' | 'rename' | 'mkdir' | 'remove' | 'syncDirectory';

interface Fault {
  readonly op: FsOp;
  /** `p` is the primary path; `dst` is the rename destination. */
  readonly match: (p: string, dst?: string) => boolean;
  /**
   * `throw` — fail the operation.
   * `lose-target` — perform a NON-ATOMIC replace: delete the destination, then
   *   fail. This is the interruption a single atomic rename is supposed to make
   *   impossible and that the journal + backup exist to survive.
   * `truncate` — write only the first half of the payload (a short write).
   */
  readonly effect: 'throw' | 'lose-target' | 'truncate';
}

function faultError(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  // Deliberately not EPERM/EACCES: those are the win32 concurrent-replace race
  // `publishTempFile` retries, and a retried fault would just be slow.
  err.code = 'EIO';
  return err;
}

interface FaultingFsOptions {
  readonly faults?: readonly Fault[];
  /** Every op the promotion performed, in order (`op path[ -> dst]`). */
  readonly log?: string[];
  /** Directories handed to `syncDirectory`, in order. */
  readonly syncedDirs?: string[];
  /** Report a directory fsync as covering this directory instead of the real one. */
  readonly misreportSyncAs?: string;
}

/**
 * A real-filesystem {@link McpJsonWriterFs} — the production seam, plus optional
 * faults. Mirrors the module's own `DEFAULT_FS` (durable write, remove,
 * directory fsync) so the injected variant is not weaker than production.
 */
function realMcpFs(options: FaultingFsOptions = {}): McpJsonWriterFs {
  const { faults = [], log, syncedDirs, misreportSyncAs } = options;

  const fire = (op: FsOp, p: string, dst?: string): Fault | undefined =>
    faults.find((f) => f.op === op && f.match(p, dst));

  return {
    readFile: async (p, enc) => {
      log?.push(`readFile ${p}`);
      const fault = fire('readFile', p);
      if (fault?.effect === 'throw') throw faultError(`injected readFile failure: ${p}`);
      return fsp.readFile(p, enc);
    },
    writeFile: async (p, data) => {
      log?.push(`writeFile ${p}`);
      const fault = fire('writeFile', p);
      if (fault?.effect === 'throw') throw faultError(`injected writeFile failure: ${p}`);
      const payload = fault?.effect === 'truncate' ? data.slice(0, Math.floor(data.length / 2)) : data;
      const handle = await fsp.open(p, 'w');
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    rename: async (src, dst) => {
      log?.push(`rename ${src} -> ${dst}`);
      const fault = fire('rename', src, dst);
      if (fault?.effect === 'lose-target') {
        fs.rmSync(dst, { force: true });
        throw faultError(`injected non-atomic replace: ${src} -> ${dst}`);
      }
      if (fault?.effect === 'throw') throw faultError(`injected rename failure: ${src} -> ${dst}`);
      return fsp.rename(src, dst);
    },
    mkdir: async (p, opts) => {
      log?.push(`mkdir ${p}`);
      if (fire('mkdir', p)?.effect === 'throw') throw faultError(`injected mkdir failure: ${p}`);
      await fsp.mkdir(p, opts);
    },
    remove: async (p) => {
      log?.push(`remove ${p}`);
      if (fire('remove', p)?.effect === 'throw') throw faultError(`injected remove failure: ${p}`);
      await fsp.rm(p, { force: true, maxRetries: 10, retryDelay: 50 });
    },
    syncDirectory: async (dir) => {
      log?.push(`syncDirectory ${dir}`);
      syncedDirs?.push(dir);
      if (fire('syncDirectory', dir)?.effect === 'throw') {
        throw faultError(`injected directory fsync failure: ${dir}`);
      }
      const outcome = await fsyncDir(dir);
      return misreportSyncAs === undefined
        ? outcome
        : ({ ...outcome, directory: misreportSyncAs } satisfies DirectorySyncOutcome);
    },
  };
}

/** A real-filesystem `WriterDeps` (what `buildWriterDeps()` produces) with an injected home. */
function realWriterDeps(home: string, overrides?: Partial<WriterFs>): WriterDeps {
  const base: WriterFs = {
    readFile: (p) => fsp.readFile(p, 'utf8'),
    writeFile: (p, content) => fsp.writeFile(p, content, 'utf8'),
    mkdir: (p, opts) => fsp.mkdir(p, opts).then(() => undefined),
    stat: (p) => fsp.stat(p),
    rename: (o, n) => fsp.rename(o, n),
    copyFile: (s, d) => fsp.copyFile(s, d),
    readdir: (p) => fsp.readdir(p),
  };
  return makeStubWriterDeps({ fs: { ...base, ...overrides }, home: () => home });
}

/** Adapt an {@link McpJsonWriterFs} to the promotion seam (what the writer does internally). */
function asPromotionFs(seam: McpJsonWriterFs): ConfigPromotionFs {
  const remove = seam.remove;
  const syncDirectory = seam.syncDirectory;
  return {
    readFile: (p) => seam.readFile(p, 'utf8'),
    writeFile: (p, data) => seam.writeFile(p, data),
    rename: (from, to) => seam.rename(from, to),
    mkdir: (p, opts) => seam.mkdir(p, opts),
    ...(remove ? { remove: (p: string) => remove(p) } : {}),
    ...(syncDirectory ? { syncDirectory: (d: string) => syncDirectory(d) } : {}),
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** An existing `.vscode/mcp.json` with a foreign server and an unrelated key. */
const OLD_MCP_JSON = JSON.stringify(
  {
    mcpServers: { 'other-server': { command: 'node', args: ['server.js'], type: 'stdio' } },
    unrelatedTopLevelKey: 'must survive',
  },
  null,
  2,
);

/** Set up `<root>/.vscode/mcp.json` with {@link OLD_MCP_JSON}. */
function seedVscodeConfig(root: string): string {
  const dir = `${root}/.vscode`;
  fs.mkdirSync(dir, { recursive: true });
  const configPath = `${dir}/mcp.json`;
  fs.writeFileSync(configPath, OLD_MCP_JSON, 'utf8');
  return configPath;
}

/** The exact bytes a successful write produces for {@link OLD_MCP_JSON}. */
async function newMcpJsonText(): Promise<string> {
  const root = makeTempDir();
  const configPath = seedVscodeConfig(root);
  await new CopilotWriter().write(makeStubWriterDeps(), defaultOptions(root));
  return fs.readFileSync(configPath, 'utf8');
}

type Arm = 'old' | 'new';

/**
 * Classify the on-disk config. A config that is absent, truncated, unparseable
 * or a mix of old and new fails HERE — that is the whole acceptance criterion.
 */
function classify(configPath: string, oldText: string, newText: string): Arm {
  expect(fs.existsSync(configPath), `config vanished: ${configPath}`).toBe(true);
  const actual = fs.readFileSync(configPath, 'utf8');
  expect(() => JSON.parse(actual) as unknown, `config is not parseable JSON: ${actual}`).not.toThrow();
  if (actual === oldText) return 'old';
  if (actual === newText) return 'new';
  throw new Error(`config is neither old-complete nor new-complete:\n${actual}`);
}

// ─── The required acceptance tests ──────────────────────────────────────────

describe('DR-18 config promotion — injected failure', () => {
  it('McpJsonWriter_InjectedFailure_LeavesOldOrNewComplete', async () => {
    const newText = await newMcpJsonText();

    // One case per DISTINCT step of stage → verify → journal → backup → commit
    // → finalize. `committed` lets a fault fire strictly after the commit rename.
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly faults: (configPath: string, state: { committed: boolean }) => readonly Fault[];
      readonly expected: Arm;
    }> = [
      {
        name: 'stage write fails',
        faults: () => [{ op: 'writeFile', match: isStageWrite, effect: 'throw' }],
        expected: 'old',
      },
      {
        name: 'staged copy is a short write (verify catches it)',
        faults: () => [{ op: 'writeFile', match: isStageWrite, effect: 'truncate' }],
        expected: 'old',
      },
      {
        name: 'journal publish fails',
        faults: (cfg) => [{ op: 'rename', match: (_p, dst) => dst === configJournalPath(cfg), effect: 'throw' }],
        expected: 'old',
      },
      {
        name: 'backup write fails (journal already durable)',
        faults: () => [{ op: 'writeFile', match: (p) => p.includes('exarchos-backup'), effect: 'throw' }],
        expected: 'old',
      },
      {
        name: 'commit rename fails',
        faults: (cfg) => [{ op: 'rename', match: (_p, dst) => dst === cfg, effect: 'throw' }],
        expected: 'old',
      },
      {
        name: 'commit rename loses the target (non-atomic replace)',
        faults: (cfg) => [{ op: 'rename', match: (_p, dst) => dst === cfg, effect: 'lose-target' }],
        expected: 'old',
      },
      {
        name: 'post-commit directory fsync fails',
        faults: (cfg, state) => [
          { op: 'rename', match: (_p, dst) => { if (dst === cfg) state.committed = true; return false; }, effect: 'throw' },
          { op: 'syncDirectory', match: () => state.committed, effect: 'throw' },
        ],
        expected: 'new',
      },
      {
        name: 'post-commit finalize fails (best-effort, never observable)',
        faults: () => [{ op: 'remove', match: (p) => p.includes('exarchos-backup'), effect: 'throw' }],
        expected: 'new',
      },
    ];

    const observed = new Map<string, Arm>();
    for (const testCase of cases) {
      const root = makeTempDir();
      const configPath = seedVscodeConfig(root);
      const state = { committed: false };
      const writer = new CopilotWriter({ fs: realMcpFs({ faults: testCase.faults(configPath, state) }) });

      await writer
        .write(makeStubWriterDeps(), defaultOptions(root))
        .catch(() => undefined); // a rejected write is fine; a torn config is not

      observed.set(testCase.name, classify(configPath, OLD_MCP_JSON, newText));
    }

    // Every injection point left a COMPLETE config…
    for (const testCase of cases) {
      expect(observed.get(testCase.name), `case: ${testCase.name}`).toBe(testCase.expected);
    }
    // …and both arms of the disjunction are actually reachable. If every case
    // yielded 'old', the commit path was never exercised and this test would be
    // asserting nothing about it.
    expect(new Set(observed.values())).toEqual(new Set<Arm>(['old', 'new']));
  });

  it('McpJsonWriter_TruncatedStage_NeverBecomesLiveConfig', async () => {
    const root = makeTempDir();
    const configPath = seedVscodeConfig(root);
    const writer = new CopilotWriter({
      fs: realMcpFs({ faults: [{ op: 'writeFile', match: isStageWrite, effect: 'truncate' }] }),
    });

    await expect(writer.write(makeStubWriterDeps(), defaultOptions(root))).rejects.toThrow(
      /does not match the requested content/,
    );

    // The live config is untouched, and the half-written staged copy was dropped.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(OLD_MCP_JSON);
    expect(scaffoldingIn(`${root}/.vscode`)).toEqual([]);
  });

  it('McpJsonWriter_CommitLosesTarget_RestoresOldFromBackup', async () => {
    const root = makeTempDir();
    const configPath = seedVscodeConfig(root);
    const writer = new CopilotWriter({
      fs: realMcpFs({ faults: [{ op: 'rename', match: (_p, dst) => dst === configPath, effect: 'lose-target' }] }),
    });

    await expect(writer.write(makeStubWriterDeps(), defaultOptions(root))).rejects.toThrow(/failed to promote/);

    // Only the BACKUP can put this back: the commit deleted the target and the
    // staged copy was cleaned up by the failed publish.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(OLD_MCP_JSON);
    expect(scaffoldingIn(`${root}/.vscode`)).toEqual([]);
  });
});

describe('DR-18 config promotion — startup/doctor recovery', () => {
  /**
   * Leave a GENUINELY interrupted promotion of `~/.claude.json` on disk: the
   * commit lost the target (non-atomic replace) AND the in-line recovery's
   * restore also failed (a double fault — the "hard crash" the tree engine
   * models the same way), so the journal and backup survive with no config in
   * place. Returns the old config text.
   */
  async function leaveInterruptedClaudeConfig(home: string, oldText: string): Promise<void> {
    const configPath = claudeConfigPath(home);
    fs.writeFileSync(configPath, oldText, 'utf8');

    const deps = realWriterDeps(home, {
      rename: async (from, to) => {
        if (to === configPath) {
          fs.rmSync(to, { force: true });
          throw faultError(`injected non-atomic replace: ${from} -> ${to}`);
        }
        await fsp.rename(from, to);
      },
    });
    // The recovery seam fails too, so the journal is left behind for a later run.
    const brokenIo: PromotionIo = {
      ...defaultPromotionIo(),
      rename: () => {
        throw faultError('injected recovery failure');
      },
    };

    await expect(
      writeClaudeCode(
        deps,
        defaultOptions(`${home}/absent-project`, { forceOverwrite: true }),
        () => ({ wrote: false, failed: false, warnings: [] }),
        brokenIo,
      ),
    ).rejects.toThrow(/failed to promote/);

    const paths = configPromotionPaths(configPath);
    expect(fs.existsSync(configPath), 'the fixture must actually be interrupted').toBe(false);
    expect(fs.existsSync(paths.journalPath), 'journal must survive the double fault').toBe(true);
    expect(fs.readFileSync(paths.backupPath, 'utf8')).toBe(oldText);
  }

  it('ClaudeConfigWriter_InterruptedPromotion_RecoversAtStartup', async () => {
    const home = makeTempDir();
    const configPath = claudeConfigPath(home);
    // The old config ALREADY registers exarchos, so the writer's MCP phase will
    // SKIP. That is deliberate: it isolates the startup entry point as the only
    // thing that can repair the interruption. A recovery call buried inside the
    // write path would never run here.
    const oldText = JSON.stringify(
      {
        mcpServers: { exarchos: { type: 'stdio', command: 'node', args: ['old.js'] } },
        personalUserSetting: 'must survive an interrupted promotion',
      },
      null,
      2,
    );
    await leaveInterruptedClaudeConfig(home, oldText);

    // The REAL production entry point: the writer `getAllWriters()` constructs,
    // with no injected seams at all, driven exactly as `onboard`'s GENERATE stage
    // and `doctor --fix` drive it. `absent-project` makes the commands/skills/
    // on-ramp phases no-op so only the config phase is in play.
    const result = await new ClaudeCodeWriter().write(
      realWriterDeps(home),
      defaultOptions(`${home}/absent-project`),
    );

    // The interrupted promotion was repaired…
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(oldText);
    // …including the user's unrelated key, which a writer that ran its
    // read-modify-write over the interrupted (absent) state would have dropped.
    const restored = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(restored.personalUserSetting).toBe('must survive an interrupted promotion');
    // …and the write itself correctly skipped, proving recovery ran BEFORE the
    // already-registered check rather than as a side effect of writing.
    expect(result.status).toBe('skipped');
    expect(result.componentsWritten).toEqual([]);
    // …and the scaffolding is gone.
    expect(scaffoldingIn(home)).toEqual([]);
  });

  it('ConfigPromotionJournal_WrittenByTheWriter_IsConsumedByTheRealRecoveryEngine', async () => {
    // Pins the coupling this design rests on: the journal path/shape is derived
    // by a PRIVATE `stagePlanFor` in `install/atomic-promotion.ts`, and the
    // writers reuse the real `recoverInterruptedPromotion` rather than
    // re-implementing recovery. If that derivation ever drifts, this test — and
    // only this test — says so.
    const home = makeTempDir();
    const configPath = claudeConfigPath(home);
    const oldText = JSON.stringify({ mcpServers: { exarchos: { type: 'stdio' } }, keep: 1 }, null, 2);
    await leaveInterruptedClaudeConfig(home, oldText);

    expect(recoverInterruptedPromotion(configPath)).toBe(true);

    expect(fs.readFileSync(configPath, 'utf8')).toBe(oldText);
    expect(scaffoldingIn(home)).toEqual([]);
    // Idempotent: a second recovery finds no journal and reports so.
    expect(recoverInterruptedPromotion(configPath)).toBe(false);
  });

  it('RecoverInterruptedConfigPromotions_NothingInterrupted_IsAnInertNoOp', async () => {
    const root = makeTempDir();
    const configPath = seedVscodeConfig(root);
    const before = fs.readFileSync(configPath, 'utf8');

    const report = recoverInterruptedConfigPromotions([configPath, `${root}/does/not/exist.json`]);

    expect(report.recovered).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.checked).toHaveLength(2);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('RecoverInterruptedConfigPromotions_RepairFails_ReportsInsteadOfThrowing', async () => {
    const home = makeTempDir();
    const configPath = claudeConfigPath(home);
    await leaveInterruptedClaudeConfig(home, JSON.stringify({ mcpServers: { exarchos: {} } }, null, 2));

    const brokenIo: PromotionIo = {
      ...defaultPromotionIo(),
      rename: () => {
        throw faultError('injected recovery failure');
      },
    };
    const report = recoverInterruptedConfigPromotions([configPath], brokenIo);

    // A startup repair that throws would abort onboarding; it reports instead,
    // and leaves the journal so the next run retries.
    expect(report.recovered).toEqual([]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.error).toMatch(/Failed to recover an interrupted config promotion/);
    expect(fs.existsSync(configPromotionPaths(configPath).journalPath)).toBe(true);
  });
});

// ─── Durability, concurrency, idempotency ───────────────────────────────────

describe('DR-18 config promotion — durable ordering (DR-16)', () => {
  it('McpJsonWriter_Promotion_FsyncsParentDirectoryAfterEveryRename', async () => {
    const root = makeTempDir();
    const configPath = seedVscodeConfig(root);
    const syncedDirs: string[] = [];
    const log: string[] = [];
    const base = realMcpFs({ log });
    // A seam that CAN prove durability. Asserted through the injected seam
    // rather than through the platform's own fsync so the assertion is
    // non-vacuous on Windows too, where a real directory fsync reports
    // `unsupported` (EPERM — there is no directory fsync on win32).
    const seam: ConfigPromotionFs = {
      ...asPromotionFs(base),
      syncDirectory: (dir) => {
        syncedDirs.push(dir);
        log.push(`syncDirectory ${dir}`);
        return Promise.resolve({ directory: dir, status: 'synced' } satisfies DirectorySyncOutcome);
      },
    };

    const report = await promoteConfigFile(configPath, '{"new":true}\n', seam);

    // Journal publish, backup publish, commit publish — each rename's directory
    // entry is forced before the next step begins.
    expect(syncedDirs).toEqual([`${root}/.vscode`, `${root}/.vscode`, `${root}/.vscode`]);
    expect(report.directoryDurability).toEqual({ directory: `${root}/.vscode`, status: 'synced' });
    expect(report.backedUp).toBe(true);

    // The fsyncs are ordered strictly AFTER their rename, never before.
    const firstSync = log.indexOf(`syncDirectory ${root}/.vscode`);
    const firstRename = log.findIndex((entry) => entry.startsWith('rename '));
    expect(firstRename).toBeGreaterThanOrEqual(0);
    expect(firstSync).toBeGreaterThan(firstRename);
  });

  it('McpJsonWriter_DirectoryFsyncCoversTheWrongDirectory_PromotionRefusesToProceed', async () => {
    // A seam that renames into one directory and fsyncs another satisfies
    // "a fsync happened" while proving nothing — durability theatre. The
    // `afterDurable` guard is what rejects it.
    const root = makeTempDir();
    const configPath = seedVscodeConfig(root);
    const writer = new CopilotWriter({ fs: realMcpFs({ misreportSyncAs: `${root}/elsewhere` }) });

    const err = await writer
      .write(makeStubWriterDeps(), defaultOptions(root))
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(causeChain(err)).toMatch(/durability barrier/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(OLD_MCP_JSON);
  });

  it('McpJsonWriter_SeamWithoutDurabilityCapability_StillPublishesAndReportsNotApplicable', async () => {
    // An injected fs that cannot express a directory fsync degrades EXPLICITLY:
    // still atomic, durability reported rather than assumed.
    const root = makeTempDir();
    const configPath = seedVscodeConfig(root);
    const full = realMcpFs();
    const seam: ConfigPromotionFs = {
      readFile: (p) => full.readFile(p, 'utf8'),
      writeFile: (p, d) => full.writeFile(p, d),
      rename: (f, t) => full.rename(f, t),
      mkdir: (p, o) => full.mkdir(p, o),
    };

    const report = await promoteConfigFile(configPath, '{"new":true}\n', seam);

    expect(report.directoryDurability.status).toBe('not-applicable');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{"new":true}\n');
  });
});

describe('DR-18 config promotion — concurrency and idempotency', () => {
  it('McpJsonWriter_ConcurrentWrites_DoNotShareAStagedCopyPath', async () => {
    // The old writers staged at a FIXED `mcp.json.tmp`. Two publishers of the
    // same config then share one staged copy: the second clobbers (or consumes)
    // the first's, and the first publishes bytes it never verified — or fails a
    // publish whose source another writer already renamed away.
    //
    // The contention is deterministic rather than hopeful: writer B runs to
    // completion INSIDE writer A's stage write, which is the worst interleaving.
    const root = makeTempDir();
    const configPath = seedVscodeConfig(root);
    const contentA = '{"writer":"A"}\n';
    const contentB = '{"writer":"B"}\n';
    const stagePaths: string[] = [];
    let inner = false;

    const base = realMcpFs();
    const record = (p: string): void => {
      if (isStageWrite(p)) stagePaths.push(p);
    };
    // Both writers go through a seam that records staged-copy paths, so the
    // assertion below sees BOTH attempts' names and can compare them.
    const seamB: ConfigPromotionFs = {
      ...asPromotionFs(base),
      writeFile: async (p, data) => {
        record(p);
        await base.writeFile(p, data);
      },
    };
    const seam: ConfigPromotionFs = {
      ...asPromotionFs(base),
      writeFile: async (p, data) => {
        record(p);
        await base.writeFile(p, data);
        if (isStageWrite(p) && !inner) {
          inner = true;
          await promoteConfigFile(configPath, contentB, seamB);
        }
      },
    };

    const report = await promoteConfigFile(configPath, contentA, seam);

    expect(stagePaths).toHaveLength(2);
    expect(stagePaths[0]).not.toBe(stagePaths[1]);
    expect(report.stagePath).toBe(stagePaths[0]);
    // A verified and published ITS OWN bytes despite B running to completion in
    // the middle of A's staging.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(contentA);
    expect(scaffoldingIn(`${root}/.vscode`)).toEqual([]);
  });

  it('McpJsonWriter_IdenticalWriteTwice_DoesNotChurnOrCorrupt', async () => {
    const root = makeTempDir();
    const configPath = seedVscodeConfig(root);
    const writer = new CopilotWriter(); // production seam, real filesystem

    const first = await writer.write(makeStubWriterDeps(), defaultOptions(root));
    const afterFirst = fs.readFileSync(configPath, 'utf8');
    const second = await writer.write(makeStubWriterDeps(), defaultOptions(root));
    const afterSecond = fs.readFileSync(configPath, 'utf8');

    expect(first.status).toBe('written');
    expect(second.status).toBe('written');
    expect(afterSecond).toBe(afterFirst);
    expect(JSON.parse(afterSecond)).toEqual(JSON.parse(afterFirst));
    // No journal, backup or staged copy survives a completed promotion.
    expect(scaffoldingIn(`${root}/.vscode`)).toEqual([]);
  });
});

// ─── Behaviour preservation ─────────────────────────────────────────────────

describe('DR-18 config promotion — existing merge semantics are unchanged', () => {
  it('McpJsonWriter_ExistingForeignServersAndKeys_SurviveThePromotion', async () => {
    const root = makeTempDir();
    const configPath = seedVscodeConfig(root);

    const result = await new CopilotWriter().write(makeStubWriterDeps(), defaultOptions(root));

    expect(result.status).toBe('written');
    expect(result.componentsWritten).toEqual(['mcp-config']);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, { command?: string; args?: string[]; type?: string }>;
      unrelatedTopLevelKey?: string;
    };
    expect(parsed.unrelatedTopLevelKey).toBe('must survive');
    expect(parsed.mcpServers['other-server']).toEqual({ command: 'node', args: ['server.js'], type: 'stdio' });
    expect(parsed.mcpServers.exarchos).toEqual({
      command: 'npx',
      args: ['-y', '@anthropic-ai/claude-code', '--mcp-server-name=exarchos'],
      type: 'stdio',
    });
    // Trailing newline preserved — the serialization is untouched by DR-18.
    expect(fs.readFileSync(configPath, 'utf8').endsWith('}\n')).toBe(true);
  });

  it('ClaudeConfigWriter_ExistingForeignServersAndKeys_SurviveThePromotion', async () => {
    const home = makeTempDir();
    const configPath = claudeConfigPath(home);
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: { 'my-other-server': { type: 'stdio', command: 'node', args: ['other.js'] } },
          someOtherKey: 'preserved',
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await new ClaudeCodeWriter().write(
      realWriterDeps(home),
      defaultOptions(`${home}/absent-project`),
    );

    expect(result.status).toBe('written');
    expect(result.componentsWritten).toContain('mcp-config');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, { type?: string; command?: string }>;
      someOtherKey?: string;
    };
    expect(parsed.someOtherKey).toBe('preserved');
    expect(parsed.mcpServers['my-other-server']?.command).toBe('node');
    expect(parsed.mcpServers.exarchos?.type).toBe('stdio');
    // No trailing newline — `~/.claude.json` keeps `JSON.stringify(…, 2)` exactly.
    expect(fs.readFileSync(configPath, 'utf8').endsWith('}')).toBe(true);
    expect(scaffoldingIn(home)).toEqual([]);
  });

  it('ClaudeConfigWriter_AlreadyRegistered_StillSkipsWithoutTouchingTheConfig', async () => {
    const home = makeTempDir();
    const configPath = claudeConfigPath(home);
    const oldText = JSON.stringify({ mcpServers: { exarchos: { type: 'stdio', command: 'node' } } }, null, 2);
    fs.writeFileSync(configPath, oldText, 'utf8');

    const result = await new ClaudeCodeWriter().write(
      realWriterDeps(home),
      defaultOptions(`${home}/absent-project`),
    );

    expect(result.status).toBe('skipped');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(oldText);
    expect(scaffoldingIn(home)).toEqual([]);
  });

  it('ClaudeConfigWriter_StagedCopyKeepsTheLegacyTmpName', async () => {
    // `claude-code.test.ts` (outside this change's declared files) pins
    // `<target>.tmp` as the staged copy for `~/.claude.json`. Pinned here too so
    // the divergence from the unique-per-attempt default is a deliberate,
    // visible decision rather than an accident — see `deployMcpConfig`.
    const home = makeTempDir();
    const configPath = claudeConfigPath(home);
    const renames: Array<{ from: string; to: string }> = [];
    const deps = realWriterDeps(home, {
      rename: async (from, to) => {
        renames.push({ from, to });
        await fsp.rename(from, to);
      },
    });

    await new ClaudeCodeWriter().write(deps, defaultOptions(`${home}/absent-project`));

    expect(renames.some((r) => r.from === `${configPath}.tmp` && r.to === configPath)).toBe(true);
  });
});

// ─── Path derivation ────────────────────────────────────────────────────────

describe('configPromotionPaths', () => {
  it('ConfigPromotionPaths_StagedCopy_IsUniquePerAttempt', () => {
    const a = configPromotionPaths('/tmp/x/.vscode/mcp.json');
    const b = configPromotionPaths('/tmp/x/.vscode/mcp.json');
    expect(a.stagePath).not.toBe(b.stagePath);
    // The deterministic halves are what recovery finds; they must NOT vary.
    expect(a.journalPath).toBe(b.journalPath);
    expect(a.backupPath).toBe(b.backupPath);
  });

  it('ConfigPromotionPaths_Parent_RoundTripsThroughDirname', () => {
    // `afterDurable` compares these strings; a `path.join` here would emit
    // backslashes on Windows and never match `path.dirname` of a POSIX path.
    const paths = configPromotionPaths('C:/Users/x/.claude.json');
    expect(path.dirname(paths.journalPath)).toBe(paths.parent);
    expect(path.dirname(paths.backupPath)).toBe(paths.parent);
    expect(path.dirname(paths.target)).toBe(paths.parent);
  });
});

// ─── Guard: the base class stays abstract over its subclasses ───────────────

describe('McpJsonWriter subclasses', () => {
  it('McpJsonWriter_SubclassConfigDir_TargetsItsOwnRuntimeConfig', async () => {
    class ScratchWriter extends McpJsonWriter {
      readonly runtime = 'cursor' as const;
      protected readonly configDir = '.cursor';
    }
    const root = makeTempDir();
    const result = await new ScratchWriter().write(makeStubWriterDeps(), defaultOptions(root));
    expect(result.runtime).toBe('cursor');
    expect(fs.existsSync(`${root}/.cursor/mcp.json`)).toBe(true);
    expect(scaffoldingIn(`${root}/.cursor`)).toEqual([]);
  });
});
