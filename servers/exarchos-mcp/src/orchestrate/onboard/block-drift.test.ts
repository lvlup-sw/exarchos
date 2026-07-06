import { describe, it, expect } from 'vitest';

import { CheckResultSchema } from '../doctor/schema.js';
import {
  AGENTS_MD_FILENAME,
  writeAgentsMdBlock,
} from '../init/writers/onramp-block.js';
import type { InsertManagedBlockDeps } from '../../onramp/managed-block.js';
import { BLOCK_DRIFT_CHECK_NAME, checkBlockDrift } from './block-drift.js';

/** In-memory synchronous fs implementing the {@link InsertManagedBlockDeps} seam. */
function memFs(seed: Record<string, string> = {}): {
  store: Map<string, string>;
  deps: InsertManagedBlockDeps;
} {
  const store = new Map<string, string>(Object.entries(seed));
  const deps: InsertManagedBlockDeps = {
    existsSync: (p) => store.has(p),
    readFileSync: (p) => {
      const v = store.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    writeFileAtomic: (p, content) => {
      store.set(p, content);
    },
    copyFileSync: (src, dest) => {
      const v = store.get(src);
      if (v !== undefined) store.set(dest, v);
    },
  };
  return { store, deps };
}

const CANON = 'Route Exarchos workflow operations through the exarchos MCP tools.';

describe('checkBlockDrift (Task 013, DR-5)', () => {
  it('doctor_BlockHashDrift_ReportsFinding', () => {
    // Install a block whose body differs from the canonical body.
    const { store, deps } = memFs();
    writeAgentsMdBlock({ projectRoot: '/proj', canonicalBody: 'STALE orientation prose.' }, deps);

    const finding = checkBlockDrift('/proj', {
      canonicalBody: CANON,
      existsSync: (p) => store.has(p),
      readFileSync: (p) => store.get(p) as string,
    });

    expect(finding.name).toBe(BLOCK_DRIFT_CHECK_NAME);
    expect(finding.status).toBe('Warning');
    expect(finding.message).toMatch(/drifted/i);
    expect(finding.fix).toBeDefined();
    // The finding is a schema-valid CheckResult.
    expect(() => CheckResultSchema.parse(finding)).not.toThrow();
  });

  it('doctor_BlockInSync_ReportsPass', () => {
    const { store, deps } = memFs();
    writeAgentsMdBlock({ projectRoot: '/proj', canonicalBody: CANON }, deps);

    const finding = checkBlockDrift('/proj', {
      canonicalBody: CANON,
      existsSync: (p) => store.has(p),
      readFileSync: (p) => store.get(p) as string,
    });

    expect(finding.status).toBe('Pass');
    expect(() => CheckResultSchema.parse(finding)).not.toThrow();
  });

  it('doctor_BlockNotInstalled_ReportsWarning', () => {
    const finding = checkBlockDrift('/proj', {
      canonicalBody: CANON,
      existsSync: () => false,
      readFileSync: () => {
        throw new Error('unused');
      },
    });

    expect(finding.status).toBe('Warning');
    expect(finding.message).toMatch(new RegExp(AGENTS_MD_FILENAME));
    expect(finding.fix).toBeDefined();
    expect(() => CheckResultSchema.parse(finding)).not.toThrow();
  });

  it('doctor_CanonicalUnavailable_ReportsSkipped', () => {
    const finding = checkBlockDrift('/proj', {
      canonicalBody: null,
      existsSync: () => true,
      readFileSync: () => '',
    });

    expect(finding.status).toBe('Skipped');
    expect(finding.reason).toBeDefined();
    expect(() => CheckResultSchema.parse(finding)).not.toThrow();
  });
});
