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
 *       `dispatch()` is wrapped by the seam, and
 *   (B) `withTelemetry` — the indirect arm dispatch() trusts to cap — itself
 *       routes the handler's raw result through `enforceResponseEconomy`.
 *
 * A future fourth execution mode that calls `coreHandler(...)` without the
 * seam fails this gate, mirroring the event-upcasting
 * (`event-store/store.upcast-seam.test.ts`) and merge-orchestrate no-bypass
 * gates already in this codebase.
 *
 * NOTE: if enforcement is ever collapsed to a single outermost seam (the
 * "stronger" refactor in the INV-17 Axis-2 follow-up), the raw `coreHandler(...)`
 * call becomes intentionally bare and this gate must be rewritten to anchor on
 * the new single seam rather than on each call site.
 *
 * Pure source-text check; introduces NO runtime dependency.
 */
import fs from 'node:fs';
import type { PluginFinding } from '../review/check-catalog.js';

const SOURCE = 'economy-seam';

/**
 * The raw tool handler is bound to `const coreHandler = ...` inside dispatch().
 * It is the single origin of the un-capped tool payload; every place it is
 * invoked or wrapped must pass through the seam.
 */
const CORE_HANDLER_DECL_RE = /\bconst\s+coreHandler\s*=/;

/**
 * A raw-handler invocation/wrap site: either `coreHandler(` (a direct call) or
 * `withTelemetry(coreHandler` (passed by reference to the telemetry seam). The
 * declaration (`coreHandler =`) and prose comments match neither form and are
 * excluded by construction.
 */
const INVOCATION_RE = /coreHandler\s*\(|withTelemetry\s*\(\s*coreHandler\b/;

/** The seam tokens that render an invocation site guarded. */
const GUARD_RE = /enforceResponseEconomy\s*\(|withTelemetry\s*\(/;

/** True for whole-line `//` comments or block-comment body/fence lines. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith('//') ||
    t.startsWith('*') ||
    t.startsWith('/*') ||
    t.startsWith('*/')
  );
}

/**
 * Scan `dispatch()` source for un-guarded raw-handler invocations (Axis A).
 *
 * @param filePath Path to `dispatch.ts` (used for the finding's `file`, and
 *   read from disk when `source` is not supplied).
 * @param source  Optional source text (dependency injection for tests).
 * @returns One finding per `coreHandler` invocation/wrap not routed through the
 *   seam, plus an anchor-liveness finding if the declaration or every
 *   invocation site has vanished (so a rename can't make the gate pass vacuously).
 */
export function lintDispatchEconomyBypass(
  filePath: string,
  source?: string,
): PluginFinding[] {
  const text = source ?? fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const findings: PluginFinding[] = [];

  let sawDeclaration = false;
  let siteCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (CORE_HANDLER_DECL_RE.test(line)) {
      sawDeclaration = true;
      continue;
    }
    if (isCommentLine(line)) continue;
    if (!INVOCATION_RE.test(line)) continue;

    siteCount += 1;

    // The guard may sit on this line, or — for a wrapped multi-line call — on
    // one of the two preceding non-blank, non-comment lines.
    let guarded = GUARD_RE.test(line);
    for (let j = i - 1, seen = 0; j >= 0 && seen < 2 && !guarded; j--) {
      if (lines[j].trim() === '' || isCommentLine(lines[j])) continue;
      seen += 1;
      if (GUARD_RE.test(lines[j])) guarded = true;
    }

    if (!guarded) {
      findings.push({
        source: SOURCE,
        severity: 'HIGH',
        file: filePath,
        line: i + 1,
        message:
          `dispatch() invokes the raw tool handler at line ${i + 1} without routing it ` +
          `through the response-economy seam (enforceResponseEconomy / withTelemetry). ` +
          `Every result-producing branch must pass through the seam (INV-17 Axis-2).`,
      });
    }
  }

  if (!sawDeclaration || siteCount === 0) {
    findings.push({
      source: SOURCE,
      severity: 'HIGH',
      file: filePath,
      message:
        `economy no-bypass gate found no coreHandler ` +
        `${!sawDeclaration ? 'declaration' : 'invocation sites'} in dispatch() — ` +
        `the seam anchor may have been renamed or removed. Update this gate to track the new anchor.`,
    });
  }

  return findings;
}

/**
 * `const rawResult = await handler(...)` — the raw payload binding inside
 * `withTelemetry`, which dispatch() trusts to cap on the telemetry-ON path.
 */
const MW_RAW_RESULT_RE = /const\s+rawResult\s*=\s*await\s+handler\s*\(/;

/** The seam applied to that raw result: `enforceResponseEconomy(rawResult, ...)`. */
const MW_SEAM_RE = /enforceResponseEconomy\s*\(\s*rawResult\b/;

/**
 * Prove the indirect arm of the seam (Axis B): `withTelemetry` must route the
 * raw handler result through `enforceResponseEconomy`. Without this, every
 * `withTelemetry(coreHandler)` site in dispatch() would be a silent bypass even
 * though the Axis-A scan passes.
 *
 * @param filePath Path to `telemetry/middleware.ts`.
 * @param source  Optional source text (dependency injection for tests).
 */
export function lintMiddlewareEconomySeam(
  filePath: string,
  source?: string,
): PluginFinding[] {
  const text = source ?? fs.readFileSync(filePath, 'utf8');
  const findings: PluginFinding[] = [];

  if (!MW_RAW_RESULT_RE.test(text)) {
    findings.push({
      source: SOURCE,
      severity: 'HIGH',
      file: filePath,
      message:
        `withTelemetry no longer binds the raw handler result via ` +
        `\`const rawResult = await handler(...)\` — the economy-seam anchor changed. ` +
        `Update this no-bypass gate to track the new binding.`,
    });
  }

  if (!MW_SEAM_RE.test(text)) {
    findings.push({
      source: SOURCE,
      severity: 'HIGH',
      file: filePath,
      message:
        `withTelemetry does not route the raw handler result through ` +
        `enforceResponseEconomy(rawResult, ...). dispatch() relies on this as its ` +
        `telemetry-ON economy seam (INV-17 Axis-2).`,
    });
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
