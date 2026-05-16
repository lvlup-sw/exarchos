// ─── Sidecar Backfill Validation (T16, #1298) ────────────────────────────────
//
// Ensures the hand-authored sidecars for the v2.10.0-preview.4 feature-freeze
// design and plan parse cleanly under DesignSidecarV1 / PlanSidecarV1. Any
// drift between the YAML and the schema is caught at test time, not in the
// gate runtime.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { DesignSidecarV1, PlanSidecarV1 } from './sidecar-schemas.js';

// CodeRabbit MAJOR #1425 r2: `__dirname` is undefined under NodeNext/ESM
// (the project's resolution mode — see CLAUDE.md). Use the ESM-safe
// `import.meta.url` → `fileURLToPath(...)` → `dirname()` chain so the
// REPO_ROOT constant resolves correctly in both ts-node and the
// vitest runner.
//
// Resolve relative to repo root from this test file's location:
// servers/exarchos-mcp/src/orchestrate/<this> → ../../../../docs/...
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('SidecarBackfill_Preview4', () => {
  it('DesignSidecar_ParsesUnderDesignV1', () => {
    const docPath = resolve(REPO_ROOT, 'docs/designs/2026-05-15-v2-10-0-preview-4-feature-freeze.sidecar.yml');
    const raw = readFileSync(docPath, 'utf-8');
    const parsed = DesignSidecarV1.safeParse(parse(raw));
    if (!parsed.success) {
      // Surface the first issue clearly when the test fails.
      throw new Error(`Design sidecar invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(parsed.success).toBe(true);
  });

  it('PlanSidecar_ParsesUnderPlanV1', () => {
    const docPath = resolve(REPO_ROOT, 'docs/plans/2026-05-15-v2-10-0-preview-4-feature-freeze.sidecar.yml');
    const raw = readFileSync(docPath, 'utf-8');
    const parsed = PlanSidecarV1.safeParse(parse(raw));
    if (!parsed.success) {
      throw new Error(`Plan sidecar invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(parsed.success).toBe(true);
  });
});
