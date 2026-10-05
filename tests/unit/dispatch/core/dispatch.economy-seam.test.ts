import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lintDispatchEconomyBypass,
  lintMiddlewareEconomySeam,
  lintEconomySeam,
} from '../../../../src/dispatch/core/dispatch.economy-seam.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DISPATCH_PATH = path.join(here, '../../../../src/dispatch/core/dispatch.ts');
const MIDDLEWARE_PATH = path.join(here, '../../../../src/projections/telemetry/middleware.ts');

describe('economy-seam no-bypass gate (INV-17 Axis-2)', () => {
  /**
   * The live check. Each result branch of the real `dispatch()`, and the
   * `withTelemetry` seam, must go through `enforceResponseEconomy`.
   */
  it('EconomySeam_RealDispatchAndMiddleware_NoBypass', () => {
    expect(lintEconomySeam(DISPATCH_PATH, MIDDLEWARE_PATH)).toEqual([]);
  });

  /** A telemetry-off branch returns the raw handler result and has no seam call. */
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
    expect(findings[0].message).toContain('outside the response-economy seam');
  });

  /** A seam call on a nearby line is not proof. It does not cover a bare `coreHandler` call. */
  it('EconomySeam_ProximityNotProof_Flagged', () => {
    const source = [
      'export async function dispatch() {',
      '  const coreHandler = resolveHandler(tool);',
      '  const cached = enforceResponseEconomy(previousResult, tool, action);',
      '  return coreHandler(args);',
      '}',
    ].join('\n');

    const findings = lintDispatchEconomyBypass(DISPATCH_PATH, source);

    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(4);
    expect(findings[0].message).toContain('proximity');
  });

  /** A guarded telemetry-off branch gives no finding. */
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

  /** A seam call that spans lines still encloses the `coreHandler` call. */
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

  /**
   * Axis B. The wrapper has no `JSON.stringify(result)` and no
   * `injectPerf(result)`, so the gate cannot prove that the return value comes
   * from the seam output.
   */
  it('EconomySeam_MiddlewareReturnsRaw_Flagged', () => {
    const source = [
      'export function withTelemetry(handler, toolName, store) {',
      '  return async (args) => {',
      '    const rawResult = await handler(args);',
      '    const result = enforceResponseEconomy(rawResult, toolName, economyAction);',
      '    return result;',
      '  };',
      '}',
    ].join('\n');

    const findings = lintMiddlewareEconomySeam(MIDDLEWARE_PATH, source);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.message.includes('derived from'))).toBe(true);
  });

  /** Axis B. The wrapper computes and measures the capped result, but returns `rawResult`. */
  it('EconomySeam_MiddlewareComputesCapButReturnsRaw_Flagged', () => {
    const source = [
      'export function withTelemetry(handler, toolName, store) {',
      '  return async (args) => {',
      '    const rawResult = await handler(args);',
      '    const result = enforceResponseEconomy(rawResult, toolName, economyAction);',
      '    const responseText = JSON.stringify(result);',
      '    const finalResult = injectPerf(result, { ms, bytes, tokens });',
      '    return rawResult; // BUG: returns the uncapped payload',
      '  };',
      '}',
    ].join('\n');

    const findings = lintMiddlewareEconomySeam(MIDDLEWARE_PATH, source);
    expect(findings.some((f) => f.message.includes('un-capped'))).toBe(true);
  });

  /** A renamed `coreHandler` must give a finding. Zero matches must not pass. */
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
