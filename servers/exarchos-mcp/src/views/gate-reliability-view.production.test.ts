import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import { TOOL_REGISTRY } from '../registry.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { handleView } from './composite.js';
import { GATE_RELIABILITY_VIEW } from './gate-reliability-view.js';
import { BUILTIN_VIEW_NAMES } from './registry.js';
import { getOrCreateMaterializer } from './tools.js';

// BASE-002 acceptance proof (structural-closure Wave 0): the gate-reliability
// read model must be reachable through production composition, not just its own
// unit test. These assertions are the containment proof the module-intent gate
// (DR-7) relies on — remove the wiring and they fail before the gate does.

describe('gate-reliability view production wiring (BASE-002)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(nodePath.join(tmpdir(), 'gate-reliability-prod-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('GateReliability_ProductionMaterializer_RegistersProjection', () => {
    const materializer = getOrCreateMaterializer(stateDir);
    expect(materializer.hasProjection(GATE_RELIABILITY_VIEW)).toBe(true);
  });

  it('GateReliability_ToolRegistry_ExposesReadOnlyViewAction', () => {
    const viewTool = TOOL_REGISTRY.find((tool) => tool.name === 'exarchos_view');
    expect(viewTool).toBeDefined();
    const action = viewTool?.actions.find((candidate) => candidate.name === 'gate_reliability');
    expect(action).toBeDefined();
    expect(BUILTIN_VIEW_NAMES.has('gate_reliability')).toBe(true);
    expect(BUILTIN_VIEW_NAMES.has(GATE_RELIABILITY_VIEW)).toBe(true);
  });

  it('GateReliability_HandleView_ReturnsDiagnosticOnlyPayload', async () => {
    const ctx: DispatchContext = {
      stateDir,
      eventStore: new EventStore(stateDir),
      enableTelemetry: false,
    };

    const result = await handleView(
      { action: 'gate_reliability', workflowId: 'base-002-stream' },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = (result.data as { data?: unknown })?.data ?? result.data;
    expect(data).toMatchObject({ diagnosticOnly: true });
    // Registry-seeded gates report `null` rather than pretending an unmeasured
    // gate is healthy.
    const gates = (data as { gates: readonly { value: number | null }[] }).gates;
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every((gate) => gate.value === null)).toBe(true);
    // Compact-by-default: the raw fold inputs stay internal.
    expect(data).not.toHaveProperty('_foldEvents');
  });

  it('GateReliability_HandleView_Detail_RestoresFoldInputs', async () => {
    const ctx: DispatchContext = {
      stateDir,
      eventStore: new EventStore(stateDir),
      enableTelemetry: false,
    };

    const result = await handleView(
      { action: 'gate_reliability', workflowId: 'base-002-stream', detail: true },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = (result.data as { data?: unknown })?.data ?? result.data;
    expect(data).toHaveProperty('_foldEvents');
  });
});
