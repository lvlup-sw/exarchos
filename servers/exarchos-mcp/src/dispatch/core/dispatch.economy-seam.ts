/**
 * Economy-seam no-bypass gate (INV-17 Axis-2 — enforcement application).
 *
 * INV-17's mechanical backstops guarantee the *coverage* axis (which actions
 * carry a budget / a total output schema — see the registry-economy and
 * registry-schema pin tests). They do NOT guarantee the second axis:
 * *enforcement application* — that every result-producing branch of
 * `dispatch()` actually routes the raw handler payload through the response-
 * economy seam (`enforceResponseEconomy`, directly or via `withTelemetry`).
 *
 * The review fix cycle for the tool-token-economy-remediation feature caught
 * two live bypasses: the telemetry-OFF branches capped nothing, so
 * `EXARCHOS_TELEMETRY=false` silently disabled all enforcement. That was a
 * local patch — it plugged the known holes. This gate makes the whole *class*
 * structurally impossible: it asserts, by source structure, that
 *
 *   (A) every invocation of the raw tool handler (`coreHandler`) inside
 *       `dispatch()` is *enclosed by* the seam — the call is the direct
 *       argument of `enforceResponseEconomy(...)`, or `coreHandler` is passed
 *       to `withTelemetry(...)`, and
 *   (B) `withTelemetry` — the indirect arm dispatch() trusts to cap — binds the
 *       seam output and *returns a value derived from it* (not the raw result).
 *
 * Axis A matches the ENCLOSING call, not mere proximity: an unrelated
 * `enforceResponseEconomy(...)` on a nearby line does not launder a bare
 * `coreHandler(...)` call (that false-negative is covered by a regression
 * fixture). A future execution mode that ships a bare `coreHandler(...)` fails
 * this gate, mirroring the event-upcasting
 * (`events/store.upcast-seam.test.ts`) and merge-orchestrate no-bypass
 * gates already in this codebase.
 *
 * NOTE: the checks are anchored to THIS code's identifiers (`coreHandler`,
 * `result`, `rawResult`, `injectPerf`). That is deliberate: a refactor that
 * renames them — including collapsing enforcement to a single outermost seam
 * (the "stronger" INV-17 Axis-2 follow-up, where `coreHandler(...)` becomes
 * intentionally bare) — MUST update this gate. It fails loud, never silent.
 *
 * Pure source-text check; introduces NO runtime dependency.
 */
import fs from 'node:fs';
import type { PluginFinding } from '../../review/check-catalog.js';

const SOURCE = 'economy-seam';

/**
 * The raw tool handler is bound to `const coreHandler = ...` inside dispatch().
 * It is the single origin of the un-capped tool payload; every place it is
 * invoked or wrapped must be enclosed by the seam.
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
 * Replace `//` line comments and `/* *\/` block comments with equal-length
 * whitespace so tokens inside prose never match, while byte offsets (and thus
 * reported line numbers) stay exact.
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
 * Scan `dispatch()` source for raw-handler invocations not *enclosed* by the
 * seam (Axis A).
 *
 * @param filePath Path to `dispatch.ts` (used for the finding's `file`, and
 *   read from disk when `source` is not supplied).
 * @param source  Optional source text (dependency injection for tests).
 * @returns One finding per `coreHandler` invocation/reference not enclosed by
 *   the seam, plus an anchor-liveness finding if the declaration or every
 *   invocation site has vanished (so a rename can't make the gate pass vacuously).
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
 * `withTelemetry`'s anchors: the raw payload binding, the seam applied to it,
 * the size measured on the CAPPED binding, and the returned envelope seeded
 * from that binding. Together they prove the returned value *derives from* the
 * seam output — not merely that a cap was computed and discarded.
 */
const MW_RAW_RESULT_RE = /const\s+rawResult\s*=\s*await\s+handler\s*\(/;
const MW_SEAM_BINDING_RE = /const\s+result\s*=\s*enforceResponseEconomy\s*\(\s*rawResult\b/;
const MW_MEASURES_CAPPED_RE = /JSON\.stringify\(\s*result\s*\)/;
const MW_INJECTS_CAPPED_RE = /injectPerf\(\s*result\b/;
const MW_RETURNS_RAW_RE = /return\s+rawResult\b/;

/**
 * Prove the indirect arm of the seam (Axis B): `withTelemetry` binds the seam
 * output (`const result = enforceResponseEconomy(rawResult, …)`), measures and
 * returns a value *derived from* that binding, and never returns the raw
 * result. Without this, a wrapper could compute the cap and then return
 * `rawResult` — every `withTelemetry(coreHandler)` site in dispatch() would be
 * a silent bypass while the Axis-A scan still passes.
 *
 * @param filePath Path to `projections/telemetry/middleware.ts`.
 * @param source  Optional source text (dependency injection for tests).
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
  // Derivation proof: the measured/returned value must come from the capped
  // `result` binding, and the raw result must never be returned directly.
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
