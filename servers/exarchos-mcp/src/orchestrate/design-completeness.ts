// ─── Design Completeness Gate ────────────────────────────────────────────────
//
// Orchestrates design document completeness checks at the ideate→plan boundary
// by calling the pure TypeScript handleDesignCompleteness function and emitting
// gate.executed events for IdeateReadinessView and CodeQualityView integration.
//
// This gate is ADVISORY — failures inform but do not block phase transitions.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { emitGateEvent } from './gate-utils.js';
import { handleDesignCompleteness as runDesignCompleteness } from './pure/design-completeness.js';
import { loadDesignSidecar } from './sidecar-lookup.js';
import type { DesignSidecarV1 } from './sidecar-schemas.js';

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleDesignCompleteness(
  args: { featureId: string; stateFile?: string; designPath?: string },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // 1. Validate input
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const streamId = args.featureId;
  // Canonical workflow-state filename convention: `${featureId}.state.json`
  // (matches storage/lifecycle.ts and the assemble-context state-file consumer).
  const stateFile = args.stateFile ?? `${stateDir}/${streamId}.state.json`;

  // 2. Prefer the sidecar (T15) when present + conformant; otherwise fall
  // back to the existing regex-scrape path with a deprecation warning
  // logged inside `loadDesignSidecar`. The regex branch is scheduled for
  // removal in v2.11 (#1298 follow-up tracking issue).
  let parsed;
  let source: 'sidecar' | 'regex' = 'regex';
  const sidecar = args.designPath ? loadDesignSidecar(args.designPath) : null;
  if (sidecar) {
    parsed = evaluateDesignSidecar(sidecar);
    source = 'sidecar';
  } else {
    try {
      parsed = runDesignCompleteness({
        stateFile,
        designFile: args.designPath,
        docsDir: 'docs/designs',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: { code: 'DESIGN_CHECK_ERROR', message: `Design completeness check failed: ${message}` },
      };
    }
  }

  // 3. Emit gate.executed event
  try {
    const store = eventStore;
    await emitGateEvent(store, streamId, 'design-completeness', 'design', parsed.passed, {
      dimension: 'D1',
      phase: 'ideate',
      advisory: true,
      findings: [...parsed.findings],
      checkCount: parsed.checkCount,
      passCount: parsed.passCount,
      failCount: parsed.failCount,
    });
  } catch {
    // Fire-and-forget: event emission failure must not break the gate check
  }

  // 4. Return result
  return {
    success: true,
    data: { ...parsed, source },
  };
}

// ─── Sidecar evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate a `DesignSidecarV1` against the same five checks the regex
 * branch performs, but using the structured input directly:
 *   1. (implicit) design doc exists — guaranteed when sidecar is present.
 *   2. Required sections present — each declared section in `sections`
 *      must have `present: true`.
 *   3. Multiple options — `options.count >= 2`.
 *   4. (skipped — state-file path already verified by the loader call site).
 *   5. Acceptance criteria — every DR in `drs` must be referenced by at
 *      least one entry in `acceptance` (advisory finding).
 */
function evaluateDesignSidecar(sidecar: DesignSidecarV1): {
  passed: boolean;
  advisory: boolean;
  findings: string[];
  checkCount: number;
  passCount: number;
  failCount: number;
} {
  const findings: string[] = [];
  let passCount = 0;
  let failCount = 0;

  // Sections: every declared section must report `present: true`. CodeRabbit
  // MAJOR #1425 r2: `sections: {}` previously passed the gate because the
  // missingSections.filter() returned an empty array — vacuously "every
  // section is present." Treat an empty sections map as a fail, mirroring
  // the legacy regex path's "no design sections found" failure.
  const sectionEntries = Object.entries(sidecar.sections);
  if (sectionEntries.length === 0) {
    failCount++;
    findings.push('No design sections declared in sidecar');
  } else {
    const missingSections = sectionEntries
      .filter(([, v]) => !v.present)
      .map(([k]) => k);
    if (missingSections.length === 0) {
      passCount++;
    } else {
      failCount++;
      findings.push(`Required sections missing: ${missingSections.join(', ')}`);
    }
  }

  // Multiple options: optional in the schema; if absent, treat as not-checked.
  if (sidecar.options) {
    if (sidecar.options.count >= 2) {
      passCount++;
    } else {
      failCount++;
      findings.push(`Found ${sidecar.options.count} option(s), expected at least 2`);
    }
  }

  // Acceptance criteria — every DR referenced at least once (advisory).
  const referenced = new Set<string>();
  for (const a of sidecar.acceptance) {
    for (const ref of a.references) referenced.add(ref);
  }
  const drsMissingAcceptance = sidecar.drs
    .map((dr) => dr.id)
    .filter((id) => !referenced.has(id));
  if (drsMissingAcceptance.length > 0) {
    findings.push(
      `Advisory: DR entries missing acceptance criteria: ${drsMissingAcceptance.join(', ')}`,
    );
  }

  return {
    passed: failCount === 0,
    advisory: true,
    findings,
    checkCount: passCount + failCount,
    passCount,
    failCount,
  };
}
