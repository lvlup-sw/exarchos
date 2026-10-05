/**
 * Outcome test for roots-based discovery of `featureId` at the dispatch boundary.
 *
 * The caller dispatches `exarchos_workflow` `get` with no `featureId`. The client declares the MCP
 * roots capability, and its one root holds an Exarchos workspace. Dispatch resolves the `featureId`
 * from the root before the action schema validates the arguments.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../src/events/store.js';
import { handleInit } from '../../src/workflow/tools.js';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import type { RootsClient } from '../../src/runtime/workspace/discovery.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

async function mktemp(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `outcome-1290-${label}-`));
}

function fileUriFor(p: string): string {
  return `file://${p}`;
}

describe('Roots-based dispatch boundary discovery (#1290)', () => {
  /**
   * `.exarchos.yml` marks the directory as a workspace, and `handleInit` creates the workflow that
   * discovery finds. The test accepts a failed `get` when the error is not `INVALID_INPUT` for
   * `featureId`. A `workspace.resolved` event with `source: 'roots'` must be on the resolved
   * stream.
   */
  it('Dispatch_MissingFeatureIdWithRootsCapability_ResolvesAutomatically', async () => {
    const workspace = await mktemp('workspace');
    const stateDir = path.join(workspace, 'docs', 'workflow-state');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(workspace, '.exarchos.yml'), '', 'utf8');

    const featureId = 'outcome-1290-roots';
    try {
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();
      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        stateDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);

      const resolver = createInMemoryResolver([]);
      resolver.snapshot({ capabilities: { roots: { listChanged: true } } });

      const rootsClient: RootsClient = {
        async list() {
          return [{ uri: fileUriFor(workspace) }];
        },
      };

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

      if (!result.success) {
        const code = result.error?.code;
        const msg = result.error?.message ?? '';
        expect(code === 'INVALID_INPUT' && /featureId/i.test(msg)).toBe(false);
      } else {
        expect(result.success).toBe(true);
      }

      const events = await eventStore.query(featureId);
      const resolved = events.find((e) => e.type === 'workspace.resolved');
      expect(resolved).toBeDefined();
      expect((resolved!.data as { source?: string }).source).toBe('roots');
    } finally {
      await rmrfAsync(workspace);
    }
  });
});
