// ─── T3.1 — RESERVED_FIELD discoverability outcome (GREEN) ────────────────
//
// Encodes the #1360 fix shipped in commit 481e51c7 (PR #1392). The contract
// being locked here has two distinct surfaces:
//
//   1. Discoverability — `exarchos_workflow.describe({actions:['update']})`
//      surfaces a `reservedFields` block sourced from
//      `RESERVED_FIELDS_DESCRIPTOR`. Callers learn the immutable boundary
//      (and the alternate write paths, e.g. `transition` for `phase`)
//      through describe instead of trial-and-error against the error
//      envelope.
//
//   2. Structured error data — when `applyDotPath` rejects an update for a
//      reserved key, the returned envelope carries an `error.data` block
//      shaped `{rejectedPath, rule, alternateWritePath}`. Callers can
//      pivot to the alternate path programmatically without parsing the
//      error message.
//
// This is a backfill: the fix landed prior; the tests are GREEN against
// current head. A future regression that strips either surface fails CI.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../src/events/store.js';
import {
  handleInit,
  handleUpdate,
} from '../../src/workflow/tools.js';
import { handleDescribe } from '../../src/describe/handler.js';
import { TOOL_REGISTRY } from '../../src/registry.js';

const workflowTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_workflow');

describe('reserved-fields discoverability outcome (#1360)', () => {
  it('Describe_UpdateAction_EnumeratesReservedFields', async () => {
    expect(workflowTool).toBeDefined();
    const result = await handleDescribe(
      { actions: ['update'] },
      workflowTool!.actions,
    );
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('update');
    const updateDesc = data.update as Record<string, unknown>;
    expect(updateDesc).toHaveProperty('reservedFields');

    const reservedFields = updateDesc.reservedFields as Record<string, unknown>;

    // The descriptor surfaces four keys; the runtime guard and the doc
    // surface derive from the same constant, so changing the descriptor
    // changes the discoverability output. Each must be non-empty.
    expect(reservedFields).toHaveProperty('topLevelImmutable');
    expect(reservedFields).toHaveProperty('underscorePrefixRule');
    expect(reservedFields).toHaveProperty('examples');
    expect(reservedFields).toHaveProperty('alternateWritePaths');

    const topLevel = reservedFields.topLevelImmutable as readonly string[];
    expect(Array.isArray(topLevel)).toBe(true);
    expect(topLevel.length).toBeGreaterThan(0);
    expect(topLevel).toContain('phase');
    expect(topLevel).toContain('workflowType');
    expect(topLevel).toContain('featureId');

    expect(typeof reservedFields.underscorePrefixRule).toBe('string');
    expect((reservedFields.underscorePrefixRule as string).length).toBeGreaterThan(0);

    const examples = reservedFields.examples as readonly string[];
    expect(Array.isArray(examples)).toBe(true);
    expect(examples.length).toBeGreaterThan(0);

    const alternates = reservedFields.alternateWritePaths as Record<string, string>;
    expect(typeof alternates).toBe('object');
    expect(Object.keys(alternates).length).toBeGreaterThan(0);
    // The canonical alternate for `phase` redirects to the `transition`
    // action — this is the most operator-load-bearing entry in the map.
    expect(alternates.phase).toMatch(/transition/);
  });

  it('Update_WithReservedTopLevelField_ReturnsStructuredErrorData', async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'outcome-reserved-fields-'),
    );
    try {
      const eventStore = new EventStore(stateDir);
      const featureId = 'outcome-1360-toplevel';

      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        stateDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);

      // `workflowType` is top-level immutable. Routes through `applyDotPath`,
      // which throws `RESERVED_FIELD` with structured data. (`phase` is
      // intercepted earlier in `handleUpdate` with INVALID_INPUT, by design
      // — phase has its own HSM-aware error path. We test the canonical
      // RESERVED_FIELD branch via a different top-level immutable.)
      const updateResult = await handleUpdate(
        { featureId, updates: { workflowType: 'debug' } },
        stateDir,
        eventStore,
      );

      expect(updateResult.success).toBe(false);
      expect(updateResult.error?.code).toBe('RESERVED_FIELD');

      const errData = updateResult.error?.data as {
        rejectedPath?: unknown;
        rule?: unknown;
        alternateWritePath?: unknown;
      } | undefined;
      expect(errData).toBeDefined();
      expect(errData!.rejectedPath).toBe('workflowType');
      expect(typeof errData!.rule).toBe('string');
      expect((errData!.rule as string).length).toBeGreaterThan(0);
      // alternateWritePath may be a populated string or null; both shapes
      // are contract-compliant per `ReservedFieldErrorData`. For
      // `workflowType` the descriptor provides a populated alternate.
      const altPath = errData!.alternateWritePath;
      expect(altPath === null || typeof altPath === 'string').toBe(true);
      if (typeof altPath === 'string') {
        expect(altPath.length).toBeGreaterThan(0);
      }
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it('Update_WithUnderscorePrefixedField_ReturnsStructuredErrorData', async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'outcome-reserved-fields-underscore-'),
    );
    try {
      const eventStore = new EventStore(stateDir);
      const featureId = 'outcome-1360-underscore';

      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        stateDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);

      // Underscore-prefixed keys are reserved for projection / event-store
      // metadata. The descriptor's `underscorePrefixRule` is surfaced as
      // the `rule` text on the structured error, and the `^_.*` regex
      // entry in `alternateWritePaths` provides the redirect to the
      // typed-event surface.
      const updateResult = await handleUpdate(
        { featureId, updates: { _meta: 'x' } },
        stateDir,
        eventStore,
      );

      expect(updateResult.success).toBe(false);
      expect(updateResult.error?.code).toBe('RESERVED_FIELD');

      const errData = updateResult.error?.data as {
        rejectedPath?: unknown;
        rule?: unknown;
        alternateWritePath?: unknown;
      } | undefined;
      expect(errData).toBeDefined();
      expect(errData!.rejectedPath).toBe('_meta');
      expect(typeof errData!.rule).toBe('string');
      expect((errData!.rule as string).length).toBeGreaterThan(0);

      const altPath = errData!.alternateWritePath;
      expect(altPath === null || typeof altPath === 'string').toBe(true);
      if (typeof altPath === 'string') {
        expect(altPath.length).toBeGreaterThan(0);
      }
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
