import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultSourcePaths,
  collectLiveAuthorities,
  collectAuthorityInputs,
  loadAuthorityLock,
  verifyContractAuthority,
  flattenActionIds,
  type AuthoritySourcePaths,
} from './authority-collector.js';
import { buildAuthorityLock, AUTHORITY_IDS } from './authority-pin.js';

function tmpFile(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

describe('collector — live measurement', () => {
  it('Collect_FlattensNonEmptyActionIds', () => {
    const ids = flattenActionIds();
    expect(ids.length).toBeGreaterThan(0);
    // Sanity: real, known ActionIds are present.
    expect(ids).toContain('exarchos_workflow.init');
    expect(ids).toContain('exarchos_event.append');
  });

  it('Collect_ProducesAllSixAuthorities', () => {
    const live = collectLiveAuthorities();
    expect(live.map((a) => a.id).sort()).toEqual([...AUTHORITY_IDS].sort());
  });

  it('Collect_IsDeterministic', () => {
    expect(collectLiveAuthorities()).toEqual(collectLiveAuthorities());
  });

  it('Collect_McpSdkSpecIsExactlyPinnedInThisRepo', () => {
    const inputs = collectAuthorityInputs();
    // The real dependency must be an exact pin (guards against the freeze
    // silently accepting a range). If someone loosens it, this fails.
    expect(inputs.mcpSdkVersionSpec).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('checked-in lockfile', () => {
  it('Lock_LoadsAndSchemaValidates', () => {
    const lock = loadAuthorityLock();
    expect(lock.approved).toBe(true);
    expect(Object.keys(lock.authorities).sort()).toEqual([...AUTHORITY_IDS].sort());
  });
});

describe('verifyContractAuthority — exit proofs', () => {
  // (d) The current, real repo state verifies successfully.
  it('Verify_RealRepoState_Passes', () => {
    const verdict = verifyContractAuthority();
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  // (a) A floating authority (range-versioned SDK dependency) BLOCKS.
  it('Verify_FloatingSdkDependency_Blocks', () => {
    const base = defaultSourcePaths();
    const realPkg = JSON.parse(fs.readFileSync(base.packageJsonFile, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // Retargeted with the extractor (task 049): seeding a range on the RETIRED
    // v1 key would leave the live `server` pin exact, so the freeze would pass
    // and this kill probe would silently stop killing.
    realPkg.dependencies['@modelcontextprotocol/server'] = '^2.0.0'; // floating!
    const floatingPkg = tmpFile('package.json', JSON.stringify(realPkg, null, 2));

    // Rebuild an approved lock from THIS floating tree — the freeze must still
    // block because the live spec is a range.
    const paths: AuthoritySourcePaths = { ...base, packageJsonFile: floatingPkg };
    const live = collectLiveAuthorities(paths);
    const floatingLock = tmpFile(
      'contract-authority.lock.json',
      JSON.stringify(buildAuthorityLock(live, { approvedBy: 'test' }), null, 2),
    );

    const verdict = verifyContractAuthority({ ...paths, lockFile: floatingLock });
    expect(verdict.ok).toBe(false);
    expect(
      verdict.violations.some((v) => v.kind === 'floating' && v.authority === 'mcp-sdk'),
    ).toBe(true);
  });

  // (b) An unapproved lock BLOCKS.
  it('Verify_UnapprovedLock_Blocks', () => {
    const base = defaultSourcePaths();
    const live = collectLiveAuthorities(base);
    const unapproved = tmpFile(
      'contract-authority.lock.json',
      JSON.stringify(buildAuthorityLock(live, { approvedBy: 'test', approved: false }), null, 2),
    );
    const verdict = verifyContractAuthority({ ...base, lockFile: unapproved });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.some((v) => v.kind === 'lock-unapproved')).toBe(true);
  });

  // (c) A digest mismatch vs. the lock BLOCKS.
  it('Verify_DigestMismatch_Blocks', () => {
    const base = defaultSourcePaths();
    const live = collectLiveAuthorities(base);
    const lock = buildAuthorityLock(live, { approvedBy: 'test' });
    const tampered = {
      ...lock,
      authorities: {
        ...lock.authorities,
        'invariant-catalog': {
          ...lock.authorities['invariant-catalog']!,
          digest: 'sha256:' + 'a'.repeat(64),
        },
      },
    };
    const mismatchLock = tmpFile(
      'contract-authority.lock.json',
      JSON.stringify(tampered, null, 2),
    );
    const verdict = verifyContractAuthority({ ...base, lockFile: mismatchLock });
    expect(verdict.ok).toBe(false);
    expect(
      verdict.violations.some((v) => v.kind === 'mismatch' && v.authority === 'invariant-catalog'),
    ).toBe(true);
  });

  // A missing / invalid lockfile fails closed rather than throwing.
  it('Verify_MissingLockfile_BlocksClosed', () => {
    const base = defaultSourcePaths();
    const missing = path.join(os.tmpdir(), 'authority-does-not-exist', 'nope.lock.json');
    const verdict = verifyContractAuthority({ ...base, lockFile: missing });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.some((v) => v.authority === '<lock>')).toBe(true);
  });
});
