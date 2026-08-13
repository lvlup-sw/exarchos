import { describe, it, expect } from 'vitest';
import {
  CONTRACT_SURFACE_VERSION,
  CONTRACT_CHANGE_CLASSES,
  majorVersion,
  minorVersion,
  negotiateVersion,
  planMigration,
  classifyVersionChange,
  changeClassSeverity,
  requiresMixedVersionRefusal,
  type ChangeClass,
} from './compatibility.js';

describe('compatibility — semver segment helpers', () => {
  it('MajorMinor_ParseCoreSegments', () => {
    expect(majorVersion('v2.3.1')).toBe(2);
    expect(minorVersion('v2.3.1')).toBe(3);
    expect(majorVersion('1')).toBe(1);
    expect(minorVersion('1')).toBe(0);
    expect(majorVersion('2.5.0-preview.3')).toBe(2);
  });
});

describe('compatibility — version negotiation', () => {
  const supported = ['1.0.0', '1.1.0', '2.0.0'];

  it('NewClient_OldServer_PicksHighestSharedVersion', () => {
    // Client wants [1.0.0, 2.0.0]; server tops out where it can.
    const out = negotiateVersion({ min: '1.0.0', max: '1.1.0' }, supported);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.version).toBe('1.1.0');
  });

  it('OldClient_NewServer_NegotiatesDownToClientCeiling', () => {
    const out = negotiateVersion({ min: '1.0.0', max: '1.0.0' }, supported);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.version).toBe('1.0.0');
  });

  it('Overlap_PicksNewestInRange', () => {
    const out = negotiateVersion({ min: '1.0.0', max: '2.0.0' }, supported);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.version).toBe('2.0.0');
  });

  it('UnsupportedRange_FailsExplicitly', () => {
    const out = negotiateVersion({ min: '3.0.0', max: '4.0.0' }, supported);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('unsupported-range');
      expect(out.error.code).toBe('UNSUPPORTED_PROTOCOL_VERSION');
      expect(out.error.exitCode).toBe(1);
      expect(out.error.layer).toBe('protocol');
    }
  });
});

describe('compatibility — directional migration', () => {
  it('Identity_WhenVersionsEqual', () => {
    const plan = planMigration('1.2.0', '1.2.0');
    expect(plan.kind).toBe('identity');
  });

  it('Forward_UpcastsOlderToNewer', () => {
    const plan = planMigration('1.1.0', '1.3.0');
    expect(plan.kind).toBe('migrate');
    if (plan.kind === 'migrate') expect(plan.direction).toBe('forward');
  });

  it('Backward_DowncastsNewerToOlder', () => {
    const plan = planMigration('1.3.0', '1.1.0');
    expect(plan.kind).toBe('migrate');
    if (plan.kind === 'migrate') expect(plan.direction).toBe('backward');
  });

  it('CrossMajor_IsIncompatible_AndDeclaresDirection', () => {
    const plan = planMigration('1.9.0', '2.0.0');
    expect(plan.kind).toBe('incompatible');
    if (plan.kind === 'incompatible') {
      expect(plan.direction).toBe('forward');
      expect(plan.error.code).toBe('VERSION_INCOMPATIBLE');
      expect(plan.error.exitCode).toBe(1);
    }
  });
});

describe('compatibility — version-change classification', () => {
  it('ClassifiesTheSemverRelationship', () => {
    expect(classifyVersionChange('1.2.3', '1.2.3')).toBe('compatible');
    expect(classifyVersionChange('1.2.3', '1.3.0')).toBe('additive');
    expect(classifyVersionChange('1.2.3', '1.2.4')).toBe('behavioral');
    expect(classifyVersionChange('1.9.9', '2.0.0')).toBe('breaking');
  });
});

describe('compatibility — change-class taxonomy (totality)', () => {
  it('ChangeClassSeverity_IsTotalOverTheUnion', () => {
    for (const cls of CONTRACT_CHANGE_CLASSES) {
      expect(['presentation-only', 'compat-review', 'security-sensitive']).toContain(
        changeClassSeverity(cls),
      );
    }
  });

  it('SecuritySensitiveClassesAreFlagged', () => {
    const sensitive: ChangeClass[] = ['authorization', 'effect', 'safety', 'idempotency'];
    for (const cls of sensitive) {
      expect(changeClassSeverity(cls)).toBe('security-sensitive');
    }
  });

  it('SecuritySensitiveChange_RefusesAnyNonIdenticalPeer', () => {
    // Even an additive minor bump of an authorization change refuses a mixed peer.
    expect(requiresMixedVersionRefusal('authorization', 'additive')).toBe(true);
    expect(requiresMixedVersionRefusal('effect', 'behavioral')).toBe(true);
    expect(requiresMixedVersionRefusal('authorization', 'compatible')).toBe(false);
  });

  it('OrdinaryChange_RefusesOnlyOnBreaking', () => {
    expect(requiresMixedVersionRefusal('cache', 'additive')).toBe(false);
    expect(requiresMixedVersionRefusal('cache', 'breaking')).toBe(true);
    expect(requiresMixedVersionRefusal('presentation', 'breaking')).toBe(true);
    expect(requiresMixedVersionRefusal('presentation', 'behavioral')).toBe(false);
  });
});

describe('compatibility — surface version', () => {
  it('ExportsASemverContractVersion', () => {
    expect(CONTRACT_SURFACE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
