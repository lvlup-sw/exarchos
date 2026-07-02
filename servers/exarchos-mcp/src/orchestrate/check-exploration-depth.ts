// ─── check_exploration_depth Gate (DR-4, Gap B) ─────────────────────────────
//
// Verifies that a `deep`-`designDepth` spec carries the template-required
// `### Exploration` section citing a `/exarchos:discover` research pass — a
// report PATH and a `correlationId` (the "deep only" section in
// `skills-src/implementation-planning/references/spec-template.md`). When the
// section is absent (or present but not citing the discover pass) the gate
// FAILS (`data.passed: false`, the advisory-carrier blocking signal the
// verification-ladder gates use).
//
// The gate SELF-SKIPS at `thin`/`standard` depth — the Exploration section is a
// deep-only obligation, so a non-`deep` spec is not held to it. The skip is
// keyed on the frozen `state.designDepth` stamp (parity with how
// `resolvePolicySkip` self-routes a per-task gate off its `riskTier` stamp): the
// gate records its routing decision as a `gate.executed` event and returns a
// skip-passing envelope rather than touching the artifact.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import type { DesignDepth } from '../workflow/plan-depth-policy.js';
import { emitGateEvent } from './gate-utils.js';
import { resolveWorkflowState } from './resolve-state.js';

/** Discriminant carried by a gate skipped because the spec is not `deep` depth. */
export const SKIPPED_BY_DEPTH = 'skipped-by-depth';

/** The exact h3 header the deep-depth template requires. */
const EXPLORATION_HEADER = /^###\s+Exploration\b/i;

/**
 * A path-like citation: `dir/file.ext` (at least one slash + a file extension),
 * matching a bare path, a backticked path, or a markdown link target — e.g.
 * `docs/research/2026-06-29-foo.md`, `` `docs/research/foo.md` ``, or
 * `[report](docs/research/foo.md)`.
 */
const PATH_CITATION = /[\w.-]+\/[\w./-]*\.[a-z0-9]+/i;

/**
 * A `correlationId` citation: either the literal `correlationId` token (the word
 * the template asks the author to cite) or the deterministic stitch value the
 * discover bridge derives (`discover-bridge:<featureId>`).
 */
const CORRELATION_ID_CITATION = /correlation[\s_-]?id|discover-bridge:/i;

/**
 * Extract the body of the `### Exploration` section (the lines under the header
 * up to the next `#`/`##`/`###` heading — `####` subsections stay in the body).
 * Returns `null` when the section header is absent.
 */
export function extractExplorationSection(markdown: string): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => EXPLORATION_HEADER.test(line));
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    // Stop at the next heading of level h1–h3 (a `####` h4 is a child of the
    // Exploration section and stays in the body).
    if (/^#{1,3}\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/** Verdict from {@link checkExplorationDepth}. */
export interface ExplorationCheckResult {
  readonly passed: boolean;
  readonly hasSection: boolean;
  readonly citesPath: boolean;
  readonly citesCorrelationId: boolean;
  readonly reason: string;
}

/**
 * Pure check: does the `deep` spec carry an `### Exploration` section that cites
 * a `/exarchos:discover` pass by PATH and `correlationId`?
 *
 * Fails when the section is absent OR present but missing either citation — the
 * section's whole purpose is the cross-document provenance link.
 */
export function checkExplorationDepth(markdown: string): ExplorationCheckResult {
  const section = extractExplorationSection(markdown);
  if (section === null) {
    return {
      passed: false,
      hasSection: false,
      citesPath: false,
      citesCorrelationId: false,
      reason:
        "deep-depth spec is missing the required '### Exploration' section " +
        '(deep specs must cite the /exarchos:discover research pass by path + correlationId).',
    };
  }

  const citesPath = PATH_CITATION.test(section);
  const citesCorrelationId = CORRELATION_ID_CITATION.test(section);
  const passed = citesPath && citesCorrelationId;

  let reason: string;
  if (passed) {
    reason = "'### Exploration' section cites the /exarchos:discover pass by path + correlationId.";
  } else {
    const missing: string[] = [];
    if (!citesPath) missing.push('a /exarchos:discover report path');
    if (!citesCorrelationId) missing.push('a correlationId');
    reason =
      "'### Exploration' section is present but does not cite " +
      `${missing.join(' and ')} (deep specs must stitch the discover pass by path + correlationId).`;
  }

  return { passed, hasSection: true, citesPath, citesCorrelationId, reason };
}

/**
 * Decide whether the gate should self-skip given the frozen `designDepth` stamp.
 *
 * The Exploration section is a DEEP-ONLY obligation, so any depth other than
 * `deep` (including an absent/unknown stamp) self-skips — the gate has teeth
 * only at `deep`. Mirrors the `{ reason } | null` shape of `resolvePolicySkip`.
 */
export function resolveExplorationSkip(
  designDepth: DesignDepth | undefined,
): { readonly reason: string } | null {
  if (designDepth === 'deep') return null;
  return {
    reason:
      `skipped — the '### Exploration' citation is a deep-depth obligation; ` +
      `designDepth=${designDepth ?? '<unset>'} is not 'deep'.`,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

interface CheckExplorationDepthArgs {
  readonly featureId: string;
  /** Path to the unified `docs/specs/` artifact. Resolved from state when absent. */
  readonly designPath?: string;
  /** Frozen `designDepth` stamp. Resolved from `state.designDepth` when absent. */
  readonly designDepth?: DesignDepth;
  /** Optional explicit `.state.json` path (legacy / no-event-store callers). */
  readonly stateFile?: string;
}

/**
 * Resolve `designDepth` and the unified-artifact path from explicit args, then
 * fall back to the workflow-state projection. Mirrors
 * `handleDesignCompleteness`'s artifact resolution (artifacts.plan preferred —
 * the unified spec under the design+plan collapse — then artifacts.design).
 */
async function resolveDepthAndPath(
  args: CheckExplorationDepthArgs,
  eventStore: EventStore,
): Promise<{ designDepth?: DesignDepth; designPath?: string }> {
  let designDepth = args.designDepth;
  let designPath = args.designPath;

  if (designDepth !== undefined && designPath !== undefined) {
    return { designDepth, designPath };
  }

  const resolved = await resolveWorkflowState({
    featureId: args.featureId,
    eventStore,
    ...(args.stateFile ? { stateFile: args.stateFile } : {}),
  });
  if ('error' in resolved) {
    // A resolution miss is not fatal here — the caller's explicit args (if any)
    // stand, and an unresolved deep-path surfaces as INVALID_INPUT downstream.
    return { designDepth, designPath };
  }

  const state = resolved.state;
  if (designDepth === undefined && typeof state.designDepth === 'string') {
    designDepth = state.designDepth as DesignDepth;
  }
  if (designPath === undefined) {
    const artifacts = state.artifacts;
    if (artifacts && typeof artifacts === 'object' && !Array.isArray(artifacts)) {
      const rec = artifacts as Record<string, unknown>;
      const candidate = rec.plan ?? rec.design;
      if (typeof candidate === 'string' && candidate.length > 0) {
        designPath = candidate;
      }
    }
  }

  return { designDepth, designPath };
}

/**
 * `check_exploration_depth` gate handler (DR-4). Self-skips at non-`deep` depth;
 * at `deep` it reads the unified spec and verifies the `### Exploration` section
 * cites the discover pass by path + correlationId. Emits a `gate.executed`
 * (gate `exploration-depth`, layer `planning`, dimension D1) on every path.
 */
export async function handleCheckExplorationDepth(
  args: CheckExplorationDepthArgs,
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!eventStore) {
    return {
      success: false,
      error: { code: 'MISWIRED_CONTEXT', message: 'handleCheckExplorationDepth: eventStore is required' },
    };
  }
  if (!args.featureId) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'featureId is required' } };
  }

  const { designDepth, designPath } = await resolveDepthAndPath(args, eventStore);

  // ── Deep-only self-skip (parity with resolvePolicySkip stamp routing) ──────
  const skip = resolveExplorationSkip(designDepth);
  if (skip) {
    try {
      await emitGateEvent(eventStore, args.featureId, 'exploration-depth', 'planning', true, {
        dimension: 'D1',
        phase: 'plan',
        designDepth: designDepth ?? null,
        skipped: true,
        discriminant: SKIPPED_BY_DEPTH,
        reason: skip.reason,
      });
    } catch {
      /* fire-and-forget */
    }
    return {
      success: true,
      data: {
        passed: true,
        skipped: true,
        discriminant: SKIPPED_BY_DEPTH,
        designDepth: designDepth ?? null,
        reason: skip.reason,
      },
    };
  }

  // ── Deep depth — the Exploration citation is required ──────────────────────
  if (!designPath) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'designPath could not be resolved — pass designPath, or record artifacts.plan/design in workflow state.',
      },
    };
  }

  let content: string;
  try {
    content = await readFile(designPath, 'utf-8');
  } catch (err) {
    return {
      success: false,
      error: { code: 'FILE_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }

  const result = checkExplorationDepth(content);

  try {
    await emitGateEvent(eventStore, args.featureId, 'exploration-depth', 'planning', result.passed, {
      dimension: 'D1',
      phase: 'plan',
      designDepth: 'deep',
      hasSection: result.hasSection,
      citesPath: result.citesPath,
      citesCorrelationId: result.citesCorrelationId,
    });
  } catch {
    /* fire-and-forget */
  }

  return {
    success: true,
    data: {
      passed: result.passed,
      skipped: false,
      designDepth: 'deep',
      hasSection: result.hasSection,
      citesPath: result.citesPath,
      citesCorrelationId: result.citesCorrelationId,
      reason: result.reason,
    },
  };
}
