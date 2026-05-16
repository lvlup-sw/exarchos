// ─── Sidecar Lookup Helper (#1298) ───────────────────────────────────────────
//
// Locates `<doc>.sidecar.yml` next to a design or plan markdown file and
// parses it via the relevant Zod schema. When the sidecar is missing or
// fails to parse cleanly, returns `null` and emits the canonical deprecation
// warning via `console.warn` so the calling gate can fall back to the
// regex-scrape path.
//
// Removal of the regex-fallback branch is scheduled for v2.11 — tracking
// issue placeholder is surfaced in the warning so it can be patched at
// merge time.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import {
  DesignSidecarV1,
  PlanSidecarV1,
  type DesignSidecarV1 as DesignSidecarV1Type,
  type PlanSidecarV1 as PlanSidecarV1Type,
} from './sidecar-schemas.js';

/**
 * Placeholder for the GitHub issue tracking removal of the regex-fallback
 * branch in v2.11. Set to a real issue number before this PR merges.
 */
export const REGEX_REMOVAL_TRACKING_ISSUE = '#<TBD>';

/**
 * Compute the conventional sidecar path for a doc: `<doc>.sidecar.yml`.
 * The doc path itself is preserved verbatim, including its `.md` suffix —
 * sidecars are always `<doc>.md.sidecar.yml` next to the markdown.
 */
export function sidecarPathFor(docPath: string): string {
  return `${docPath}.sidecar.yml`;
}

/**
 * Emit the canonical deprecation warning. Pre-v2.10.0-preview.4 docs are
 * grandfathered; older docs SHOULD log but are not load-bearing.
 */
function logDeprecation(docPath: string): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[DEPRECATION] sidecar missing for ${docPath}; if pre-v2.10.0-preview.4, ` +
      `grandfathered; otherwise regenerate via npm run sidecar:emit. Regex ` +
      `fallback scheduled for removal in v2.11. Tracking: ${REGEX_REMOVAL_TRACKING_ISSUE}`,
  );
}

/**
 * Internal: load + schema-validate a sidecar of the requested shape.
 */
function loadSidecar<T extends z.ZodTypeAny>(
  docPath: string,
  schema: T,
): z.infer<T> | null {
  const sidecarPath = sidecarPathFor(docPath);
  if (!existsSync(sidecarPath)) {
    logDeprecation(docPath);
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(sidecarPath, 'utf-8');
  } catch {
    logDeprecation(docPath);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    // Malformed YAML — fall back to regex with deprecation log.
    logDeprecation(docPath);
    return null;
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    logDeprecation(docPath);
    return null;
  }

  return result.data;
}

/**
 * Load the `<design>.sidecar.yml` next to `designPath`. Returns the parsed
 * `DesignSidecarV1` when available + conformant, or `null` (logging a
 * deprecation warning) when missing, unreadable, malformed, or
 * non-conformant.
 */
export function loadDesignSidecar(designPath: string): DesignSidecarV1Type | null {
  return loadSidecar(designPath, DesignSidecarV1);
}

/**
 * Load the `<plan>.sidecar.yml` next to `planPath`. Returns the parsed
 * `PlanSidecarV1` when available + conformant, or `null` (logging a
 * deprecation warning) when missing, unreadable, malformed, or
 * non-conformant.
 */
export function loadPlanSidecar(planPath: string): PlanSidecarV1Type | null {
  return loadSidecar(planPath, PlanSidecarV1);
}
