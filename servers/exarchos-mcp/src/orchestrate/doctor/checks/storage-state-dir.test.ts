import { describe, it, expect } from 'vitest';
import { storageStateDir } from './storage-state-dir.js';
import { makeStubProbes } from './__shared__/make-stub-probes.js';

const signal = new AbortController().signal;

describe('storage-state-dir', () => {
  it('StorageStateDir_PresentAndWritable_ReturnsPass', async () => {
    const probes = makeStubProbes({
      stateDir: '/tmp/state',
      fs: {
        readFile: () => { throw new Error('unused'); },
        stat: async () => ({ isDirectory: () => true }),
        access: async () => { /* writable */ },
      },
    });

    const result = await storageStateDir(probes, signal);

    expect(result.category).toBe('storage');
    expect(result.name).toBe('state-dir');
    expect(result.status).toBe('Pass');
    expect(result.message).toContain('/tmp/state');
    expect(result.fix).toBeUndefined();
  });

  it('StorageStateDir_Missing_ReturnsFail', async () => {
    const probes = makeStubProbes({
      stateDir: '/tmp/missing',
      fs: {
        readFile: () => { throw new Error('unused'); },
        stat: async () => { const e = new Error('ENOENT'); (e as NodeJS.ErrnoException).code = 'ENOENT'; throw e; },
        access: async () => { throw new Error('unused'); },
      },
    });

    const result = await storageStateDir(probes, signal);

    expect(result.status).toBe('Fail');
    expect(result.message).toContain('/tmp/missing');
    expect(result.fix).toBe('Create state directory: mkdir -p "/tmp/missing"');
  });

  it('StorageStateDir_ReadOnly_ReturnsWarning', async () => {
    const probes = makeStubProbes({
      stateDir: '/tmp/readonly',
      fs: {
        readFile: () => { throw new Error('unused'); },
        stat: async () => ({ isDirectory: () => true }),
        access: async () => { const e = new Error('EACCES'); (e as NodeJS.ErrnoException).code = 'EACCES'; throw e; },
      },
    });

    const result = await storageStateDir(probes, signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('/tmp/readonly');
    expect(result.fix).toBe('Ensure state directory is writable: chmod u+w "/tmp/readonly"');
  });
});
