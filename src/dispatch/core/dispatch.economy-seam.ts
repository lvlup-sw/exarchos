/**
 * The economy-seam no-bypass gate. It checks by source structure that every result branch of
 * `dispatch()` sends the raw handler payload through `enforceResponseEconomy`.
 * - Axis A: each `coreHandler` use in `dispatch()` is the direct argument of
 *   `enforceResponseEconomy(...)`, or `coreHandler` goes to `withTelemetry(...)`. A seam call on a
 *   nearby line does not count.
 * - Axis B: `withTelemetry` binds the seam output and returns a value from it, not the raw result.
 * The checks name this code's identifiers (`coreHandler`, `result`, `rawResult`, `injectPerf`).
 * A rename must update this gate, and the gate fails until it does. The check reads source text only.
 */
import fs from 'node:fs';
import type { PluginFinding } from '../../review/check-catalog.js';

const SOURCE = 'economy-seam';

/**
 * The `const coreHandler = ...` binding inside `dispatch()`. It is the origin of the uncapped payload,
 * so the seam must enclose each place that calls or wraps it.
 */
const CORE_HANDLER_DECL_RE = /\bconst\s+coreHandler\s*=/;

/**
 * A `coreHandler(...)` call that is the direct argument of the seam:
 * `enforceResponseEconomy( [await] coreHandler(`. The `coreHandler` token index
 * within a match anchors the guarded call site.
 */
const GUARDED_CALL_RE =
  /\benforceResponseEconomy\s*\(\s*(?:await\s+)?coreHandler\s*\(/g;

/** `coreHandler` passed by reference to the telemetry seam: `withTelemetry(coreHandler`. */
const GUARDED_WRAP_RE = /\bwithTelemetry\s*\(\s*coreHandler\b/g;

/** Every occurrence of the `coreHandler` identifier (call or reference). */
const ANY_CORE_HANDLER_RE = /\bcoreHandler\b/g;

/**
 * Replaces comments with whitespace of equal length. Tokens in comments then do not match, and the
 * reported line numbers stay exact.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** 1-indexed line number of a byte offset. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/** Collect the `coreHandler`-token offsets claimed by a guard pattern. */
function guardedHandlerOffsets(src: string, re: RegExp): Set<number> {
  const offsets = new Set<number>();
  for (const m of src.matchAll(re)) {
    const rel = m[0].lastIndexOf('coreHandler');
    if (rel >= 0 && m.index !== undefined) offsets.add(m.index + rel);
  }
  return offsets;
}

/**
 * Scans `dispatch()` source for raw-handler uses that the seam does not enclose (Axis A).
 *
 * @param filePath Path to `dispatch.ts`. The function reads it when `source` is absent.
 * @param source  Optional source text for tests.
 * @returns One finding for each `coreHandler` use outside the seam. It adds one more finding when the
 *   declaration or all use sites are gone, so a rename cannot pass the gate.
 */
export function lintDispatchEconomyBypass(
  filePath: string,
  source?: string,
): PluginFinding[] {
  const raw = source ?? fs.readFileSync(filePath, 'utf8');
  const src = stripComments(raw);
  const findings: PluginFinding[] = [];

  const guarded = new Set<number>([
    ...guardedHandlerOffsets(src, GUARDED_CALL_RE),
    ...guardedHandlerOffsets(src, GUARDED_WRAP_RE),
  ]);

  const declMatch = CORE_HANDLER_DECL_RE.exec(src);
  const declHandlerOffset = declMatch
    ? declMatch.index + declMatch[0].lastIndexOf('coreHandler')
    : -1;

  let siteCount = 0;
  for (const m of src.matchAll(ANY_CORE_HANDLER_RE)) {
    const idx = m.index;
    if (idx === undefined || idx === declHandlerOffset) continue;
    siteCount += 1;
    if (guarded.has(idx)) continue;

    findings.push({
      source: SOURCE,
      severity: 'HIGH',
      file: filePath,
      line: lineAt(raw, idx),
      message:
        `dispatch() references the raw tool handler at line ${lineAt(raw, idx)} ` +
        `outside the response-economy seam. A raw-handler call must be the direct ` +
        `argument of enforceResponseEconomy(...) or pass coreHandler to ` +
        `withTelemetry(...); proximity to an unrelated seam call does not count ` +
        `(INV-17 Axis-2).`,
    });
  }

  if (declHandlerOffset < 0 || siteCount === 0) {
    findings.push({
      source: SOURCE,
      severity: 'HIGH',
      file: filePath,
      message:
        `economy no-bypass gate found no coreHandler ` +
        `${declHandlerOffset < 0 ? 'declaration' : 'invocation sites'} in dispatch() — ` +
        `the seam anchor may have been renamed or removed. Update this gate to track the new anchor.`,
    });
  }

  return findings;
}

/**
 * The anchors in `withTelemetry`: the raw payload binding, the seam on it, the size measured on the
 * capped binding, and the envelope built from it. Together they prove that the return value comes
 * from the seam output.
 */
const MW_RAW_RESULT_RE = /const\s+rawResult\s*=\s*await\s+handler\s*\(/;
const MW_SEAM_BINDING_RE = /const\s+result\s*=\s*enforceResponseEconomy\s*\(\s*rawResult\b/;
const MW_MEASURES_CAPPED_RE = /JSON\.stringify\(\s*result\s*\)/;
const MW_INJECTS_CAPPED_RE = /injectPerf\(\s*result\b/;
const MW_RETURNS_RAW_RE = /return\s+rawResult\b/;

/**
 * Checks the indirect arm of the seam (Axis B). `withTelemetry` must bind the seam output, measure
 * and return a value from that binding, and never return `rawResult`. The measured and returned
 * value must come from the capped `result`. A wrapper that returns `rawResult` makes each
 * `withTelemetry(coreHandler)` site a bypass that Axis A cannot see.
 *
 * @param filePath Path to `projections/telemetry/middleware.ts`.
 * @param source  Optional source text for tests.
 */
export function lintMiddlewareEconomySeam(
  filePath: string,
  source?: string,
): PluginFinding[] {
  const raw = source ?? fs.readFileSync(filePath, 'utf8');
  const src = stripComments(raw);
  const findings: PluginFinding[] = [];

  const push = (message: string): void => {
    findings.push({ source: SOURCE, severity: 'HIGH', file: filePath, message });
  };

  if (!MW_RAW_RESULT_RE.test(src)) {
    push(
      `withTelemetry no longer binds the raw handler result via ` +
        `\`const rawResult = await handler(...)\` — the economy-seam anchor changed. ` +
        `Update this no-bypass gate to track the new binding.`,
    );
  }
  if (!MW_SEAM_BINDING_RE.test(src)) {
    push(
      `withTelemetry does not bind the seam output via ` +
        `\`const result = enforceResponseEconomy(rawResult, ...)\`. dispatch() relies on ` +
        `this as its telemetry-ON economy seam (INV-17 Axis-2).`,
    );
  }
  if (!MW_MEASURES_CAPPED_RE.test(src) || !MW_INJECTS_CAPPED_RE.test(src)) {
    push(
      `withTelemetry measures or returns a value not derived from the capped ` +
        `\`result\` binding (expected JSON.stringify(result) and injectPerf(result, ...)). ` +
        `The cap must be applied to what is measured and returned, not computed and discarded.`,
    );
  }
  if (MW_RETURNS_RAW_RE.test(src)) {
    push(
      `withTelemetry returns the un-capped \`rawResult\` directly — the telemetry-ON ` +
        `path bypasses the economy seam (INV-17 Axis-2).`,
    );
  }

  return findings;
}

/** Run both axes of the economy no-bypass gate over the live source files. */
export function lintEconomySeam(
  dispatchPath: string,
  middlewarePath: string,
): PluginFinding[] {
  return [
    ...lintDispatchEconomyBypass(dispatchPath),
    ...lintMiddlewareEconomySeam(middlewarePath),
  ];
}
