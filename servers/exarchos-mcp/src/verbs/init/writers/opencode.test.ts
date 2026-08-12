import { describe, it, expect } from 'vitest';
import { OpenCodeWriter } from './opencode.js';
import type { ConfigWriteResult } from '../schema.js';
import { makeStubWriterDeps } from '../probes.js';
import type { WriteOptions } from './writer.js';

const stubDeps = makeStubWriterDeps();
const defaultOptions: WriteOptions = { projectRoot: '/project', nonInteractive: false, forceOverwrite: false };

describe('OpenCodeWriter', () => {
  it('OpenCodeWriter_Write_ReturnsStub', async () => {
    const writer = new OpenCodeWriter();
    const result: ConfigWriteResult = await writer.write(stubDeps, defaultOptions);

    expect(result.runtime).toBe('opencode');
    expect(result.status).toBe('stub');
    expect(result.componentsWritten).toEqual([]);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings![0]).toContain('OpenCode');
    expect(result.warnings![0]).toContain('not yet finalized');
  });
});
