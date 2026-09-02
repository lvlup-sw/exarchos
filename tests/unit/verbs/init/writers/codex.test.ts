import { describe, it, expect } from 'vitest';
import { CodexWriter } from '../../../../../src/verbs/init/writers/codex.js';
import type { ConfigWriteResult } from '../../../../../src/verbs/init/schema.js';
import { makeStubWriterDeps } from '../../../../../src/verbs/init/probes.js';
import type { WriteOptions } from '../../../../../src/verbs/init/writers/writer.js';

const stubDeps = makeStubWriterDeps();
const defaultOptions: WriteOptions = { projectRoot: '/project', nonInteractive: false, forceOverwrite: false };

describe('CodexWriter', () => {
  it('CodexWriter_Write_ReturnsStub', async () => {
    const writer = new CodexWriter();
    const result: ConfigWriteResult = await writer.write(stubDeps, defaultOptions);

    expect(result.runtime).toBe('codex');
    expect(result.status).toBe('stub');
    expect(result.componentsWritten).toEqual([]);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings![0]).toContain('Codex');
    expect(result.warnings![0]).toContain('not yet finalized');
  });
});
