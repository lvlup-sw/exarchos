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
  ConfigParseError,
  readJsonConfig,
  writeJsonConfigAtomic,
  type AtomicJsonFs,
} from '../../../../src/install/operations/atomic-json.js';
import { readConfig, writeConfig } from '../../../../src/install/operations/config.js';
import { readMcpConfig, writeMcpConfig } from '../../../../src/install/operations/mcp.js';

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
      writeSync: (fd, data) => {
        fs.writeSync(fd, data);
      },
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync,
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
