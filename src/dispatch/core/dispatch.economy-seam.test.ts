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
const MIDDLEWARE_PATH = path.join(here, '../../projections/telemetry/middleware.ts');

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
    expect(findings[0].message).toContain('outside the response-economy seam');
  });

  // Proximity is not proof (CodeRabbit 3568453403): an UNRELATED preceding
  // enforceResponseEconomy call must NOT launder a bare coreHandler call.
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

  // Robust to a wrapped multi-line call: the enclosing enforce spans lines.
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

  // Axis B: if withTelemetry returns the raw result, flag it.
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

    // Missing JSON.stringify(result)/injectPerf(result) — derivation unproven.
    const findings = lintMiddlewareEconomySeam(MIDDLEWARE_PATH, source);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.message.includes('derived from'))).toBe(true);
  });

  // Axis B, sharper (CodeRabbit 3568453414): the cap is COMPUTED and measured,
  // but the wrapper still returns the un-capped rawResult.
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
