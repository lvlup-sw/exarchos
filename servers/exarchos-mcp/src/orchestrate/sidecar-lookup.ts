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

import { orchestrateLogger } from '../logger.js';
import {
  DesignSidecarV1,
  PlanSidecarV1,
  type DesignSidecarV1 as DesignSidecarV1Type,
  type PlanSidecarV1 as PlanSidecarV1Type,
} from './sidecar-schemas.js';

/**
 * GitHub issue tracking removal of the regex-fallback branch in v2.11.
 * Filed alongside #1298 (v2.10.0-preview.4 PR D2).
 */
export const REGEX_REMOVAL_TRACKING_ISSUE = '#1407';

/**
 * Compute the conventional sidecar path for a doc: `<base>.sidecar.yml`.
 *
 * A trailing `.md` extension on `docPath` is stripped before appending
 * `.sidecar.yml` so the on-disk convention matches the sidecars shipped
 * alongside the docs (`docs/designs/foo.md` →
 * `docs/designs/foo.sidecar.yml`). Inputs without a `.md` suffix have
 * `.sidecar.yml` appended verbatim.
 */
export function sidecarPathFor(docPath: string): string {
  const base = docPath.endsWith('.md') ? docPath.slice(0, -3) : docPath;
  return `${base}.sidecar.yml`;
}

/**
 * Build the canonical deprecation warning string. Surfaced both via pino
 * (`orchestrateLogger.warn`) for operator-visible logs and returned to
 * callers/tests so the gate response can include the same text.
 */
export function buildDeprecationMessage(docPath: string): string {
  return (
    `[DEPRECATION] sidecar missing for ${docPath}; if pre-v2.10.0-preview.4, ` +
    `grandfathered; otherwise regenerate via npm run sidecar:emit. Regex ` +
    `fallback scheduled for removal in v2.11. Tracking: ${REGEX_REMOVAL_TRACKING_ISSUE}`
  );
}

/**
 * Emit the canonical deprecation warning. Pre-v2.10.0-preview.4 docs are
 * grandfathered; older docs SHOULD log but are not load-bearing.
 *
 * Goes through `orchestrateLogger` (pino subsystem='orchestrate') so we
 * stay inside the project's no-console-in-production policy (#1119);
 * tests spy on the logger instance directly.
 */
function logDeprecation(docPath: string): void {
  orchestrateLogger.warn({ docPath, gate: 'sidecar-lookup' }, buildDeprecationMessage(docPath));
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
