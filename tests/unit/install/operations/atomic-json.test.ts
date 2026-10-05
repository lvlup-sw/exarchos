// Tests for the atomic JSON configuration writers and for the readers that reject corruption.
// `~/.claude.json` and the Exarchos config are user-owned files. A failed
// `writeFileSync` leaves the target with neither the old configuration nor the new one.
// Thus each writer must apply the whole document or nothing, and each reader
// must not treat a corrupt file as an absent file.

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
} from '../../../../src/install/operations/atomic-json.js';
import { readConfig, writeConfig } from '../../../../src/install/operations/config.js';
import { readMcpConfig, writeMcpConfig } from '../../../../src/install/operations/mcp.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

describe('atomic JSON configuration I/O (EFF-008)', () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-008-'));
    target = path.join(dir, 'config.json');
  });

  afterEach(() => {
    rmrf(dir);
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
    expect(tempArtifacts()).toEqual([]);
  });

  /** The target keeps the exact bytes of the previous configuration, and no temp file stays. */
  it.each([
    ['write', 'writeSync'],
    ['fsync', 'fsyncSync'],
    ['rename', 'renameSync'],
  ] as const)(
    'AtomicWrite_FailureAt_%s_PreservesThePriorConfiguration',
    (_label, failingCall) => {
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

      expect(fs.readFileSync(target, 'utf-8')).toBe(before);
      expect(readJsonConfig<{ keep: string }>(target)?.keep).toBe('me');
      expect(tempArtifacts()).toEqual([]);
    },
  );

  it('AtomicWrite_FailureBeforeAnyPriorFile_LeavesNoTarget', () => {
    const io = realFs();
    io.renameSync = () => {
      throw new Error('injected rename failure');
    };

    expect(() => writeJsonConfigAtomic(target, { version: 1 }, io)).toThrow();
    expect(fs.existsSync(target)).toBe(false);
    expect(tempArtifacts()).toEqual([]);
  });

  /**
   * `fs.writeSync` can write fewer bytes than requested, and that is not an error.
   * This filesystem writes half of the bytes and reports the full count. Only a
   * read of the temp file can show the truncation. The fixture does real partial
   * writes to a real descriptor, and the test asserts the bytes on disk.
   */
  it('AtomicJson_ShortWrite_FailsRatherThanPromotingPartialContents', () => {
    writeJsonConfigAtomic(target, { version: 1, keep: 'me', padding: 'x'.repeat(4096) });
    const before = fs.readFileSync(target, 'utf-8');

    const io = realFs();
    io.writeSync = (fd, data, offset, length) => {
      const half = Math.max(1, Math.floor(length / 2));
      fs.writeSync(fd, data, offset, half);
      return length;
    };

    expect(() =>
      writeJsonConfigAtomic(target, { version: 2, keep: 'gone', padding: 'y'.repeat(4096) }, io),
    ).toThrow(AtomicWriteError);

    expect(fs.readFileSync(target, 'utf-8')).toBe(before);
    expect(readJsonConfig<{ keep: string }>(target)?.keep).toBe('me');
    expect(tempArtifacts()).toEqual([]);
  });

  /**
   * This filesystem writes zero bytes and raises no error. A retry loop on that
   * result never ends, so the writer must throw.
   */
  it('AtomicJson_StalledWrite_ThrowsInsteadOfSpinning', () => {
    writeJsonConfigAtomic(target, { version: 1, keep: 'me' });
    const before = fs.readFileSync(target, 'utf-8');

    const io = realFs();
    io.writeSync = () => 0;

    expect(() => writeJsonConfigAtomic(target, { version: 2, keep: 'gone' }, io)).toThrow(
      AtomicWriteError,
    );
    expect(fs.readFileSync(target, 'utf-8')).toBe(before);
    expect(tempArtifacts()).toEqual([]);
  });

  /**
   * A filesystem that writes part of the buffer and reports the true count is legal.
   * The writer must complete the write, so the target holds the whole new document.
   */
  it('AtomicJson_TruthfulShortWrite_IsCompletedNotAbandoned', () => {
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

  /** `JSON.stringify` returns `undefined` for this value, so no JSON document exists to write. */
  it('AtomicJson_UnserializableValue_IsRefusedBeforeTouchingTheTarget', () => {
    writeJsonConfigAtomic(target, { version: 1, keep: 'me' });
    const before = fs.readFileSync(target, 'utf-8');

    expect(() => writeJsonConfigAtomic(target, undefined)).toThrow(AtomicWriteError);
    expect(fs.readFileSync(target, 'utf-8')).toBe(before);
    expect(tempArtifacts()).toEqual([]);
  });

  /** The fixture is a truncated document, such as a non-atomic write or an incomplete manual edit leaves. */
  it('ReadJsonConfig_CorruptFile_ThrowsTypedErrorNotSilentDefault', () => {
    fs.writeFileSync(target, '{ "mcpServers": { "exarchos": ', 'utf-8');

    expect(() => readJsonConfig(target)).toThrow(ConfigParseError);
    try {
      readJsonConfig(target);
    } catch (err) {
      expect((err as ConfigParseError).code).toBe('CONFIG_PARSE_ERROR');
      expect((err as ConfigParseError).filePath).toBe(target);
    }
  });

  /**
   * An absent file is a normal first-run state. A reader that gives the same result
   * for an absent file and a corrupt file lets a later write replace a config silently.
   */
  it('ReadJsonConfig_MissingFile_IsAbsentNotCorrupt', () => {
    expect(readJsonConfig(path.join(dir, 'nope.json'))).toBeNull();
  });
});

describe('config writers route through the atomic primitive (EFF-008)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-008-writers-'));
  });

  afterEach(() => {
    rmrf(dir);
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

  /**
   * A reader that returns `{}` for a corrupt file makes the next merge-and-write
   * delete each server that the user configured.
   */
  it('ReadMcpConfig_CorruptFile_ThrowsRatherThanReturningEmpty', () => {
    const filePath = path.join(dir, 'claude.json');
    fs.writeFileSync(filePath, '{ "mcpServers": ', 'utf-8');
    expect(() => readMcpConfig(filePath)).toThrow(ConfigParseError);
  });

  it('ReadMcpConfig_MissingFile_ReturnsEmpty', () => {
    expect(readMcpConfig(path.join(dir, 'absent.json'))).toEqual({});
  });
});
