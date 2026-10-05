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
} from '../../../src/contract/authority-collector.js';
import { buildAuthorityLock, AUTHORITY_IDS } from '../../../src/contract/authority-pin.js';

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

  /** A range in the real dependency fails this test, so the freeze does not accept one silently. */
  it('Collect_McpSdkSpecIsExactlyPinnedInThisRepo', () => {
    const inputs = collectAuthorityInputs();
    expect(inputs.mcpSdkVersionSpec).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('Collect_StrategosContractsSpec_IsExactlyPinnedInThisRepo', () => {
    expect(collectAuthorityInputs().strategosContractsVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

/** Reads the real package.json and writes a copy that `edit` has changed. */
function editedPackageJson(edit: (pkg: Record<string, Record<string, string>>) => void): string {
  const realPkg = JSON.parse(
    fs.readFileSync(defaultSourcePaths().packageJsonFile, 'utf8'),
  ) as Record<string, Record<string, string>>;
  edit(realPkg);
  return tmpFile('package.json', JSON.stringify(realPkg, null, 2));
}

describe('collector — strategos-contracts pin location', () => {
  const pkgName = '@lvlup-sw/strategos-contracts';

  it('Collect_StrategosContractsInDevDependenciesOnly_ReadsThePin', () => {
    const file = editedPackageJson((pkg) => {
      delete pkg.dependencies![pkgName];
      pkg.devDependencies![pkgName] = '9.8.7';
    });
    const inputs = collectAuthorityInputs({ ...defaultSourcePaths(), packageJsonFile: file });
    expect(inputs.strategosContractsVersion).toBe('9.8.7');
  });

  it('Collect_StrategosContractsInDependenciesOnly_ReadsThePin', () => {
    const file = editedPackageJson((pkg) => {
      delete pkg.devDependencies![pkgName];
      pkg.dependencies![pkgName] = '9.8.6';
    });
    const inputs = collectAuthorityInputs({ ...defaultSourcePaths(), packageJsonFile: file });
    expect(inputs.strategosContractsVersion).toBe('9.8.6');
  });

  it('Verify_StrategosContractsInNeitherSection_BlocksAsFloating', () => {
    const file = editedPackageJson((pkg) => {
      delete pkg.dependencies![pkgName];
      delete pkg.devDependencies![pkgName];
    });
    const verdict = verifyContractAuthority({ ...defaultSourcePaths(), packageJsonFile: file });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toContainEqual(
      expect.objectContaining({ kind: 'floating', authority: 'strategos-contracts' }),
    );
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
  it('Verify_RealRepoState_Passes', () => {
    const verdict = verifyContractAuthority();
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  /**
   * A range on the live `@modelcontextprotocol/server` dependency is a floating authority.
   * A range on a retired key leaves the live pin exact, and this kill probe then kills nothing.
   * The lock is built as approved from the floating tree, and the freeze must still block.
   */
  it('Verify_FloatingSdkDependency_Blocks', () => {
    const base = defaultSourcePaths();
    const realPkg = JSON.parse(fs.readFileSync(base.packageJsonFile, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    realPkg.dependencies['@modelcontextprotocol/server'] = '^2.0.0';
    const floatingPkg = tmpFile('package.json', JSON.stringify(realPkg, null, 2));

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

  /** A missing lockfile gives a blocked verdict and does not throw. */
  it('Verify_MissingLockfile_BlocksClosed', () => {
    const base = defaultSourcePaths();
    const missing = path.join(os.tmpdir(), 'authority-does-not-exist', 'nope.lock.json');
    const verdict = verifyContractAuthority({ ...base, lockFile: missing });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.some((v) => v.authority === '<lock>')).toBe(true);
  });
});
