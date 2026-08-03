import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { EnvelopeSchema } from '../../schemas/envelope.js';
import type { CompositeTool, ToolAction } from '../../registry.js';
import type { AuthorityVerdict } from '../authority-pin.js';
import { deriveMetaModel } from './meta-model.js';
import type { MetaModel } from './meta-model.js';
import { compile, activeChangeClasses } from './compile.js';
import type { CompilerDiagnostic } from './compile.js';
import { derivePolicy } from './meta-model.js';

// ─── Authority-verdict stubs ─────────────────────────────────────────────────

const okVerdict: AuthorityVerdict = { ok: true, violations: [], report: 'ok (stub)' };
const blockedVerdict: AuthorityVerdict = {
  ok: false,
  violations: [{ authority: 'mcp-sdk', kind: 'floating', message: 'floating spec ^1.0.0' }],
  report: 'contract authority BLOCKED — 1 violation(s)',
};
const OK = { verifyAuthority: () => okVerdict } as const;

// ─── Mutable-clone helpers (no `any`) ────────────────────────────────────────

function cloneAsUnknown(mm: MetaModel): unknown {
  return JSON.parse(JSON.stringify(mm)) as unknown;
}
function rec(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected a record');
  return v as Record<string, unknown>;
}
function firstEntry(mm: unknown): Record<string, unknown> {
  const actions = rec(mm).actions;
  if (!Array.isArray(actions) || actions.length === 0) throw new Error('no actions');
  return rec(actions[0]);
}

// ─── Synthetic registry (for line-ending stability at the compile boundary) ──

function makeAction(overrides: Partial<ToolAction> & { name: string }): ToolAction {
  return {
    description: 'synthetic',
    schema: z.object({ x: z.string() }),
    phases: new Set<string>(),
    roles: new Set<string>(['lead']),
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: {
      safety: 'read-only',
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    ...overrides,
  };
}
function makeTool(name: string, actions: readonly ToolAction[]): CompositeTool {
  return { name, description: `tool ${name}`, actions };
}

// ─── Exit proof (a) — repeated generation is byte-identical ──────────────────

describe('compile — deterministic byte-stable generation (exit proof a)', () => {
  it('ProducesByteIdenticalOutputWhenCompiledTwice', () => {
    const mm = deriveMetaModel();
    const r1 = compile(mm, OK);
    const r2 = compile(mm, OK);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.output.serialized).toBe(r2.output.serialized);
      expect(r1.output.digest).toBe(r2.output.digest);
      expect(r1.output.serialized.length).toBeGreaterThan(1000);
    }
  });

  it('EmitsAllDescriptorsAndAContractDigestBoundToTheFixtures', () => {
    const r = compile(deriveMetaModel(), OK);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.descriptors.length).toBe(deriveMetaModel().actions.length);
      expect(r.output.proofFixtures.actions.length).toBe(r.output.descriptors.length);
      expect(r.output.proofFixtures.contractDigest).toBe(r.output.contractDigest);
      expect(r.output.contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});

// ─── Exit proof (b) — a missing policy field FAILS compilation ───────────────

describe('compile — missing policy field fails (exit proof b)', () => {
  it('RejectsAnEntryMissingARequiredPolicyField', () => {
    const mm = cloneAsUnknown(deriveMetaModel());
    const entry = firstEntry(mm);
    const economy = rec(rec(entry.policy).economy);
    delete economy.budgetTokens;

    const r = compile(mm, OK);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const d = r.diagnostics.find(
        (x) => x.code === 'MISSING_POLICY_FIELD' && x.path === 'policy.economy.budgetTokens',
      );
      expect(d).toBeDefined();
      expect(d?.actionId).toBe(entry.actionId);
    }
  });

  it('RejectsAnEntryMissingAnEntirePolicyBlock', () => {
    const mm = cloneAsUnknown(deriveMetaModel());
    const entry = firstEntry(mm);
    delete rec(entry.policy).cancellation;

    const r = compile(mm, OK);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.diagnostics.some(
          (x) => x.code === 'MISSING_POLICY_FIELD' && x.path === 'policy.cancellation',
        ),
      ).toBe(true);
    }
  });
});

// ─── Exit proof (c) — an incompatible schema field FAILS compilation ─────────

describe('compile — incompatible surface binding fails (exit proof c)', () => {
  it('RejectsAnUnknownStableErrorCode', () => {
    const mm = cloneAsUnknown(deriveMetaModel());
    const entry = firstEntry(mm);
    (entry.errorCodes as string[]).push('NONEXISTENT_CONTRACT_CODE');

    const r = compile(mm, OK);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.some((x) => x.code === 'UNKNOWN_ERROR_CODE')).toBe(true);
    }
  });

  it('RejectsAnEntryDeclaringAMismatchedSurfaceVersion', () => {
    const mm = cloneAsUnknown(deriveMetaModel());
    const entry = firstEntry(mm);
    entry.surfaceVersion = '2.0.0';

    const r = compile(mm, OK);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.diagnostics.some(
          (x) => x.code === 'INCOMPATIBLE_SURFACE_VERSION' && x.path === 'surfaceVersion',
        ),
      ).toBe(true);
    }
  });

  it('RejectsAMalformedInputSchema', () => {
    const mm = cloneAsUnknown(deriveMetaModel());
    const entry = firstEntry(mm);
    entry.inputSchema = { notASchema: true };

    const r = compile(mm, OK);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.diagnostics.some((x) => x.code === 'INCOMPATIBLE_SCHEMA' && x.path === 'inputSchema'),
      ).toBe(true);
    }
  });

  it('RejectsAnUnknownOutputKind', () => {
    const mm = cloneAsUnknown(deriveMetaModel());
    const entry = firstEntry(mm);
    (entry.outputKinds as string[]).push('teleported');

    const r = compile(mm, OK);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.some((x) => x.code === 'UNKNOWN_OUTPUT_KIND')).toBe(true);
    }
  });
});

// ─── Exit proof (d) — a floating/unapproved authority BLOCKS generation ──────

describe('compile — authority freeze blocks generation (exit proof d)', () => {
  it('RefusesToCompileAValidModelWhenAuthorityIsNotOk', () => {
    const r = compile(deriveMetaModel(), { verifyAuthority: () => blockedVerdict });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The gate runs BEFORE validation: a valid model yields exactly the one
      // authority block, nothing else.
      expect(r.diagnostics).toHaveLength(1);
      expect(r.diagnostics[0]?.code).toBe('AUTHORITY_BLOCKED');
      expect(r.diagnostics[0]?.message).toContain('BLOCKED');
    }
  });

  it('BlocksEvenWhenTheModelAlsoHasFieldFaults', () => {
    const mm = cloneAsUnknown(deriveMetaModel());
    delete rec(firstEntry(mm).policy).economy;
    const r = compile(mm, { verifyAuthority: () => blockedVerdict });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.every((x) => x.code === 'AUTHORITY_BLOCKED')).toBe(true);
    }
  });

  it('CompilesAgainstTheRealCheckedInAuthorityFreeze', () => {
    // Integration: the default gate is the real verifyContractAuthority(), which
    // reads the approved lockfile in this tree.
    const r = compile(deriveMetaModel());
    expect(r.ok).toBe(true);
  });
});

// ─── Exit proof (e) — stable across key-order & line-ending differences ──────

describe('compile — stable across key-order and platform differences (exit proof e)', () => {
  it('IsInsensitiveToEntryKeyInsertionOrder', () => {
    const base = deriveMetaModel();
    const reordered: MetaModel = {
      actions: base.actions.map((e) => ({
        policy: e.policy,
        outputKinds: e.outputKinds,
        errorCodes: e.errorCodes,
        outputSchema: e.outputSchema,
        inputSchema: e.inputSchema,
        surfaceVersion: e.surfaceVersion,
        description: e.description,
        action: e.action,
        tool: e.tool,
        actionId: e.actionId,
      })),
      surfaceVersion: base.surfaceVersion,
    };
    const r1 = compile(base, OK);
    const r2 = compile(reordered, OK);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.output.serialized).toBe(r2.output.serialized);
    }
  });

  it('IsInsensitiveToCrlfVsLfInSourceDescriptions', () => {
    const crlf = deriveMetaModel([
      makeTool('exarchos_probe', [makeAction({ name: 'probe', description: 'a\r\nb\r\n' })]),
    ]);
    const lf = deriveMetaModel([
      makeTool('exarchos_probe', [makeAction({ name: 'probe', description: 'a\nb' })]),
    ]);
    const r1 = compile(crlf, OK);
    const r2 = compile(lf, OK);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.output.serialized).toBe(r2.output.serialized);
    }
  });
});

// ─── Diagnostics are deterministic ───────────────────────────────────────────

describe('compile — diagnostics are deterministically ordered', () => {
  it('ReturnsIdenticalDiagnosticsAcrossRuns', () => {
    const build = (): unknown => {
      const mm = cloneAsUnknown(deriveMetaModel());
      const entry = firstEntry(mm);
      (entry.errorCodes as string[]).push('ZZZ_BAD_CODE');
      entry.surfaceVersion = '9.9.9';
      delete rec(rec(entry.policy).economy).budgetTokens;
      return mm;
    };
    const r1 = compile(build(), OK);
    const r2 = compile(build(), OK);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (!r1.ok && !r2.ok) {
      const strip = (d: readonly CompilerDiagnostic[]): string => JSON.stringify(d);
      expect(strip(r1.diagnostics)).toBe(strip(r2.diagnostics));
    }
  });
});

// ─── Compatibility report ────────────────────────────────────────────────────

describe('activeChangeClasses — policy-gated change-class activation', () => {
  it('OmitsMutationClassesForAReadOnlyAction', () => {
    const policy = derivePolicy(makeAction({ name: 'ro' }));
    const classes = activeChangeClasses(policy);
    expect(classes).toContain('authorization');
    expect(classes).not.toContain('effect');
    expect(classes).not.toContain('safety');
  });

  it('ActivatesEffectAndSafetyForACompensableDestructiveAction', () => {
    const policy = derivePolicy(
      makeAction({
        name: 'rm',
        annotations: {
          safety: 'compensable',
          readOnly: false,
          destructive: true,
          idempotent: false,
          openWorld: false,
        },
      }),
    );
    const classes = activeChangeClasses(policy);
    expect(classes).toContain('effect');
    expect(classes).toContain('safety');
  });

  it('SurfacesSecuritySensitiveActionsInTheReport', () => {
    const r = compile(deriveMetaModel(), OK);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.compatibilityReport.compatibleWithSurface).toBe(true);
      expect(r.output.compatibilityReport.versionChange).toBe('compatible');
      expect(r.output.compatibilityReport.securitySensitiveActionCount).toBeGreaterThan(0);
    }
  });
});
