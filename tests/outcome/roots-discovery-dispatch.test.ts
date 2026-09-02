// ─── T08 (#1290) — Roots-based dispatch-boundary discovery (outcome) ────────
//
// End-to-end pin for the dispatch-boundary integration: a caller dispatches
// `exarchos_workflow.get` with NO `featureId`, the client has declared the
// MCP roots capability, and a single root contains an Exarchos workspace.
// Dispatch resolves the featureId from the root before per-action schema
// validation, so the call lands as if the caller had supplied it
// explicitly — instead of returning the legacy `INVALID_INPUT: featureId
// is required` envelope.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../src/events/store.js';
import { handleInit } from '../../src/workflow/tools.js';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import type { RootsClient } from '../../src/runtime/workspace/discovery.js';

async function mktemp(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `outcome-1290-${label}-`));
}

function fileUriFor(p: string): string {
  return `file://${p}`;
}

describe('Roots-based dispatch boundary discovery (#1290)', () => {
  it('Dispatch_MissingFeatureIdWithRootsCapability_ResolvesAutomatically', async () => {
    const workspace = await mktemp('workspace');
    const stateDir = path.join(workspace, 'docs', 'workflow-state');
    await fs.mkdir(stateDir, { recursive: true });
    // `.exarchos.yml` marks the workspace; the state file below carries
    // the resolvable featureId.
    await fs.writeFile(path.join(workspace, '.exarchos.yml'), '', 'utf8');

    const featureId = 'outcome-1290-roots';
    try {
      // Initialize a real workflow so dispatch can succeed end-to-end.
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();
      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        stateDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);

      // Build the dispatch context with a roots-declaring resolver and
      // a single-root client adapter pointing at the workspace.
      const resolver = createInMemoryResolver([]);
      resolver.snapshot({ capabilities: { roots: { listChanged: true } } });

      const rootsClient: RootsClient = {
        async list() {
          return [{ uri: fileUriFor(workspace) }];
        },
      };

      // Dispatch with NO featureId in the args. The legacy contract
      // produced INVALID_INPUT here; the new contract must resolve via
      // roots and succeed.
      const result = await dispatch(
        'exarchos_workflow',
        { action: 'get' },
        {
          stateDir,
          eventStore,
          enableTelemetry: false,
          capabilityResolver: resolver,
          rootsClient,
          cwd: workspace,
        },
      );

      // Either the call succeeds outright (workflow exists, get returns
      // state), or it succeeds at the dispatch boundary and any further
      // failure is unrelated to featureId resolution. The contract we
      // pin here is: dispatch did NOT return `INVALID_INPUT: featureId
      // is required`.
      if (!result.success) {
        const code = result.error?.code;
        const msg = result.error?.message ?? '';
        expect(code === 'INVALID_INPUT' && /featureId/i.test(msg)).toBe(false);
      } else {
        // Success path: handler observed the resolved featureId.
        expect(result.success).toBe(true);
      }

      // `workspace.resolved` event landed on the resolved stream with
      // source='roots' so audit queries can trace the inference.
      const events = await eventStore.query(featureId);
      const resolved = events.find((e) => e.type === 'workspace.resolved');
      expect(resolved).toBeDefined();
      expect((resolved!.data as { source?: string }).source).toBe('roots');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
