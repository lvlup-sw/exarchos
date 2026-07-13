import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lintDispatchEconomyBypass,
  lintMiddlewareEconomySeam,
  lintEconomySeam,
} from './dispatch.economy-seam.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DISPATCH_PATH = path.join(here, 'dispatch.ts');
const MIDDLEWARE_PATH = path.join(here, '..', 'telemetry', 'middleware.ts');

describe('economy-seam no-bypass gate (INV-17 Axis-2)', () => {
  // The live proof: every result-producing branch of the real dispatch() and
  // the withTelemetry seam route through enforceResponseEconomy. Would fail if
  // a new execution mode shipped an un-capped branch (the class of defect the
  // tool-token-economy-remediation review caught).
  it('EconomySeam_RealDispatchAndMiddleware_NoBypass', () => {
    expect(lintEconomySeam(DISPATCH_PATH, MIDDLEWARE_PATH)).toEqual([]);
  });

  // The exact regression class the review caught: a telemetry-OFF leaf that
  // returns the raw handler result WITHOUT the seam.
  it('EconomySeam_UnguardedTelemetryOffBranch_Flagged', () => {
    const source = [
      'export async function dispatch() {',
      '  const coreHandler = resolveHandler(tool);',
      '  let result;',
      '  if (ctx.enableTelemetry) {',
      '    const wrapped = withTelemetry(coreHandler, tool, ctx.eventStore);',
      '    result = await wrapped(args);',
      '  } else {',
      '    result = await coreHandler(args); // BYPASS: no enforceResponseEconomy',
      '  }',
      '  return result;',
      '}',
    ].join('\n');

    const findings = lintDispatchEconomyBypass(DISPATCH_PATH, source);

    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(8);
    expect(findings[0].severity).toBe('HIGH');
    expect(findings[0].message).toContain('without routing it');
  });

  // A guarded telemetry-OFF branch (the shipped fix) produces no finding.
  it('EconomySeam_GuardedTelemetryOffBranch_Clean', () => {
    const source = [
      'export async function dispatch() {',
      '  const coreHandler = resolveHandler(tool);',
      '  let result;',
      '  if (ctx.enableTelemetry) {',
      '    const wrapped = withTelemetry(coreHandler, tool, ctx.eventStore);',
      '    result = await wrapped(args);',
      '  } else {',
      '    result = enforceResponseEconomy(await coreHandler(args), tool, action);',
      '  }',
      '  return result;',
      '}',
    ].join('\n');

    expect(lintDispatchEconomyBypass(DISPATCH_PATH, source)).toEqual([]);
  });

  // Robust to a wrapped multi-line call: the seam sits on a preceding line.
  it('EconomySeam_MultiLineWrappedCall_Clean', () => {
    const source = [
      'export async function dispatch() {',
      '  const coreHandler = resolveHandler(tool);',
      '  const result = enforceResponseEconomy(',
      '    await coreHandler(args),',
      '    tool,',
      '    action,',
      '  );',
      '  return result;',
      '}',
    ].join('\n');

    expect(lintDispatchEconomyBypass(DISPATCH_PATH, source)).toEqual([]);
  });

  // Axis B: if withTelemetry stops routing the raw result through the seam, the
  // withTelemetry(coreHandler) sites become silent bypasses — flag it.
  it('EconomySeam_MiddlewareDropsSeam_Flagged', () => {
    const source = [
      'export function withTelemetry(handler, toolName, store) {',
      '  return async (args) => {',
      '    const rawResult = await handler(args);',
      '    const result = rawResult; // seam removed',
      '    return result;',
      '  };',
      '}',
    ].join('\n');

    const findings = lintMiddlewareEconomySeam(MIDDLEWARE_PATH, source);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('enforceResponseEconomy');
  });

  // Anchor liveness: a renamed coreHandler must fail loudly, not pass vacuously.
  it('EconomySeam_RenamedAnchor_Flagged', () => {
    const source = [
      'export async function dispatch() {',
      '  const handlerFn = resolveHandler(tool);',
      '  const result = enforceResponseEconomy(await handlerFn(args), tool, action);',
      '  return result;',
      '}',
    ].join('\n');

    const findings = lintDispatchEconomyBypass(DISPATCH_PATH, source);

    expect(
      findings.some((f) => f.message.includes('anchor may have been renamed')),
    ).toBe(true);
  });
});
