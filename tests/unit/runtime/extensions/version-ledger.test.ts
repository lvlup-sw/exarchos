import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { FileVersionLedger, InMemoryVersionLedger } from '../../../../src/runtime/extensions/version-ledger.js';

describe('InMemoryVersionLedger (P03-08 anti-rollback)', () => {
  it('Ledger_RecordsAndReadsHighestVersion', async () => {
    const ledger = new InMemoryVersionLedger();
    expect(await ledger.highestAdmitted('ext.a')).toBeUndefined();
    await ledger.recordAdmitted('ext.a', 5);
    expect(await ledger.highestAdmitted('ext.a')).toBe(5);
  });

  it('Ledger_Monotonic_LowerRecordDoesNotLowerMark', async () => {
    const ledger = new InMemoryVersionLedger();
    await ledger.recordAdmitted('ext.a', 5);
    await ledger.recordAdmitted('ext.a', 2);
    expect(await ledger.highestAdmitted('ext.a')).toBe(5);
  });
});

describe('FileVersionLedger (P03-08 durable anti-rollback)', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ext-ledger-'));
    file = path.join(dir, 'versions.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('Ledger_MissingFile_ReturnsUndefined', async () => {
    const ledger = new FileVersionLedger(file);
    expect(await ledger.highestAdmitted('ext.a')).toBeUndefined();
  });

  it('Ledger_PersistsAcrossInstances', async () => {
    await new FileVersionLedger(file).recordAdmitted('ext.a', 7);
    // A brand-new instance re-reads persisted state — survives a restart.
    expect(await new FileVersionLedger(file).highestAdmitted('ext.a')).toBe(7);
  });

  it('Ledger_Monotonic_AcrossInstances', async () => {
    await new FileVersionLedger(file).recordAdmitted('ext.a', 7);
    await new FileVersionLedger(file).recordAdmitted('ext.a', 3);
    expect(await new FileVersionLedger(file).highestAdmitted('ext.a')).toBe(7);
  });

  it('Ledger_CorruptFile_FailsClosed', async () => {
    await writeFile(file, 'not json {{{');
    const ledger = new FileVersionLedger(file);
    await expect(ledger.highestAdmitted('ext.a')).rejects.toThrow();
  });
});
