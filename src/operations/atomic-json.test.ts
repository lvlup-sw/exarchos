// ─── EFF-008: atomic configuration writes + corruption recovery ──────────────
//
// `~/.claude.json` and the Exarchos config are user-owned files. A failed
// `writeFileSync` leaves the target neither the old configuration nor the new
// one, and the next read fails on a file the user never edited. These are the
// one effect class where "partially applied" is strictly worse than "not
// applied", so the writers must be all-or-nothing and the readers must refuse to
// treat corruption as absence.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AtomicWriteError,
  ConfigParseError,
  readJsonConfig,
  writeJsonConfigAtomic,
  type AtomicJsonFs,
} from './atomic-json.js';
import { readConfig, writeConfig } from './config.js';
import { readMcpConfig, writeMcpConfig } from './mcp.js';

describe('atomic JSON configuration I/O (EFF-008)', () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-008-'));
    target = path.join(dir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function realFs(): AtomicJsonFs {
    return {
      mkdirSync: fs.mkdirSync,
      openSync: fs.openSync,
      writeSync: (fd, data, offset, length) => fs.writeSync(fd, data, offset, length),
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync,
      readFileSync: (filePath) => fs.readFileSync(filePath),
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
    };
  }

  function tempArtifacts(): string[] {
    return fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp'));
  }

  it('AtomicWrite_HappyPath_ReplacesTargetWithReparseableContent', () => {
    writeJsonConfigAtomic(target, { version: 1, servers: ['a'] });
    expect(readJsonConfig<{ version: number }>(target)?.version).toBe(1);
    // No temp artifacts survive a clean write.
    expect(tempArtifacts()).toEqual([]);
  });

  it.each([
    ['write', 'writeSync'],
    ['fsync', 'fsyncSync'],
    ['rename', 'renameSync'],
  ] as const)(
    'AtomicWrite_FailureAt_%s_PreservesThePriorConfiguration',
    (_label, failingCall) => {
      // Seed a valid prior configuration.
      writeJsonConfigAtomic(target, { version: 1, keep: 'me' });
      const before = fs.readFileSync(target, 'utf-8');

      const io = realFs();
      const boom = new Error(`injected ${failingCall} failure`);
      (io as unknown as Record<string, unknown>)[failingCall] = () => {
        throw boom;
      };

      expect(() => writeJsonConfigAtomic(target, { version: 2, keep: 'gone' }, io)).toThrow(
        boom,
      );

      // The target is byte-identical to the prior valid configuration — never a
      // truncated or half-written document.
      expect(fs.readFileSync(target, 'utf-8')).toBe(before);
      expect(readJsonConfig<{ keep: string }>(target)?.keep).toBe('me');
      // And no temp artifact is left behind to be mistaken for the real file.
      expect(tempArtifacts()).toEqual([]);
    },
  );

  it('AtomicWrite_FailureBeforeAnyPriorFile_LeavesNoTarget', () => {
    const io = realFs();
    io.renameSync = () => {
      throw new Error('injected rename failure');
    };

    expect(() => writeJsonConfigAtomic(target, { version: 1 }, io)).toThrow();
    // Never a partially-created target for a first write.
    expect(fs.existsSync(target)).toBe(false);
    expect(tempArtifacts()).toEqual([]);
  });

  // ─── The short-write hazard ────────────────────────────────────────────────
  //
  // `fs.writeSync` may transfer fewer bytes than asked; that is its contract,
  // not an error. The module used to discard the return value, so a short write
  // produced a truncated temp file which was then fsync'd and renamed over the
  // user's good configuration. Nothing threw and nothing logged — the loss
  // surfaced at the user's NEXT read, on a file they never edited.
  //
  // These fixtures perform real, partial writes against a real fd rather than
  // inspecting a mock's arguments: what is asserted is the bytes on disk.

  it('AtomicJson_ShortWrite_FailsRatherThanPromotingPartialContents', () => {
    writeJsonConfigAtomic(target, { version: 1, keep: 'me', padding: 'x'.repeat(4096) });
    const before = fs.readFileSync(target, 'utf-8');

    // A filesystem that accepts half of what it is handed and ACKNOWLEDGES the
    // full amount. The truncation is invisible to the caller's return value —
    // only reading the file back can see it.
    const io = realFs();
    io.writeSync = (fd, data, offset, length) => {
      const half = Math.max(1, Math.floor(length / 2));
      fs.writeSync(fd, data, offset, half);
      return length;
    };

    expect(() =>
      writeJsonConfigAtomic(target, { version: 2, keep: 'gone', padding: 'y'.repeat(4096) }, io),
    ).toThrow(AtomicWriteError);

    // The prior configuration is byte-identical: the partial document never
    // reached the target.
    expect(fs.readFileSync(target, 'utf-8')).toBe(before);
    expect(readJsonConfig<{ keep: string }>(target)?.keep).toBe('me');
    expect(tempArtifacts()).toEqual([]);
  });

  it('AtomicJson_StalledWrite_ThrowsInsteadOfSpinning', () => {
    writeJsonConfigAtomic(target, { version: 1, keep: 'me' });
    const before = fs.readFileSync(target, 'utf-8');

    // Zero bytes transferred and no error raised. Looping on this would hang, so
    // "no forward progress" is a failure, not a short write to retry.
    const io = realFs();
    io.writeSync = () => 0;

    expect(() => writeJsonConfigAtomic(target, { version: 2, keep: 'gone' }, io)).toThrow(
      AtomicWriteError,
    );
    expect(fs.readFileSync(target, 'utf-8')).toBe(before);
    expect(tempArtifacts()).toEqual([]);
  });

  it('AtomicJson_TruthfulShortWrite_IsCompletedNotAbandoned', () => {
    // The ordinary case the loop exists for: a filesystem that transfers part of
    // the buffer and says so. That is legal, so the write must COMPLETE — the
    // target ends up holding the whole new document, not a prefix of it and not
    // the old one.
    const io = realFs();
    io.writeSync = (fd, data, offset, length) => {
      const chunk = Math.max(1, Math.floor(length / 3));
      return fs.writeSync(fd, data, offset, Math.min(chunk, length));
    };

    const payload = { version: 2, servers: Array.from({ length: 200 }, (_, i) => `srv-${i}`) };
    writeJsonConfigAtomic(target, payload, io);

    expect(readJsonConfig(target)).toEqual(payload);
    expect(tempArtifacts()).toEqual([]);
  });

  it('AtomicJson_UnserializableValue_IsRefusedBeforeTouchingTheTarget', () => {
    writeJsonConfigAtomic(target, { version: 1, keep: 'me' });
    const before = fs.readFileSync(target, 'utf-8');

    // `JSON.stringify` returns `undefined` here, which the old code detected
    // only indirectly by parsing the literal string "undefined\n".
    expect(() => writeJsonConfigAtomic(target, undefined)).toThrow(AtomicWriteError);
    expect(fs.readFileSync(target, 'utf-8')).toBe(before);
    expect(tempArtifacts()).toEqual([]);
  });

  it('ReadJsonConfig_CorruptFile_ThrowsTypedErrorNotSilentDefault', () => {
    // A truncated write from a pre-atomic version of this code, or an operator's
    // half-finished edit.
    fs.writeFileSync(target, '{ "mcpServers": { "exarchos": ', 'utf-8');

    expect(() => readJsonConfig(target)).toThrow(ConfigParseError);
    try {
      readJsonConfig(target);
    } catch (err) {
      expect((err as ConfigParseError).code).toBe('CONFIG_PARSE_ERROR');
      expect((err as ConfigParseError).filePath).toBe(target);
    }
  });

  it('ReadJsonConfig_MissingFile_IsAbsentNotCorrupt', () => {
    // Absence is a normal first-run state and must stay distinguishable from
    // corruption — conflating them is how a config gets silently overwritten.
    expect(readJsonConfig(path.join(dir, 'nope.json'))).toBeNull();
  });
});

describe('config writers route through the atomic primitive (EFF-008)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-008-writers-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('WriteConfig_CreatesParentsAndRoundTrips', () => {
    const filePath = path.join(dir, 'nested', 'exarchos.json');
    writeConfig(filePath, { version: '1.0.0', hashes: { 'a.md': 'abc' } });
    expect(readConfig(filePath)).toEqual({ version: '1.0.0', hashes: { 'a.md': 'abc' } });
    expect(fs.readdirSync(path.dirname(filePath)).filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('ReadConfig_CorruptFile_ThrowsTypedError', () => {
    const filePath = path.join(dir, 'exarchos.json');
    fs.writeFileSync(filePath, 'not json', 'utf-8');
    expect(() => readConfig(filePath)).toThrow(ConfigParseError);
  });

  it('WriteMcpConfig_PreservesUnrelatedKeysAndRoundTrips', () => {
    const filePath = path.join(dir, 'claude.json');
    writeMcpConfig(filePath, { mcpServers: { exarchos: { command: 'exarchos' } } });
    expect(readMcpConfig(filePath).mcpServers?.exarchos).toEqual({ command: 'exarchos' });
  });

  it('ReadMcpConfig_CorruptFile_ThrowsRatherThanReturningEmpty', () => {
    // Returning `{}` here would make the next merge-and-write silently DELETE
    // every server the user had configured.
    const filePath = path.join(dir, 'claude.json');
    fs.writeFileSync(filePath, '{ "mcpServers": ', 'utf-8');
    expect(() => readMcpConfig(filePath)).toThrow(ConfigParseError);
  });

  it('ReadMcpConfig_MissingFile_ReturnsEmpty', () => {
    expect(readMcpConfig(path.join(dir, 'absent.json'))).toEqual({});
  });
});
