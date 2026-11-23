/**
 * A project hook must not run when the project file is the only source.
 * No trust record is present. The event tool still appends the event.
 * These tests load `.exarchos.yml` and call the real event dispatch.
 * A hook command must not create a marker file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliDispatchContext } from '../../../src/adapters/cli/cli.js';
import { createMcpDispatchContext } from '../../../src/adapters/mcp/mcp.js';
import { invokeContractAction } from '../../../src/contract/cli/generated-client.js';
import { initializeContext } from '../../../src/dispatch/core/context.js';
import { dispatch } from '../../../src/dispatch/core/dispatch.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const MARKER_WAIT_MS = 2000;
const STREAM_ID = 'feature-alpha';

type Entry = 'mcp' | 'cli';
type EventAction = 'append' | 'batch_append';

/**
 * Builds the dispatch context for one product entry.
 * The CLI entry uses the local operator identity. The MCP entry uses a session identity.
 */
async function openEntry(
  entry: Entry,
  projectRoot: string,
  stateDir: string,
): Promise<DispatchContext> {
  const base = await initializeContext(stateDir, { projectRoot });
  if (entry === 'cli') return createCliDispatchContext(base);
  return createMcpDispatchContext(base, {
    sessionId: 'hook-probe-session',
    clientInfo: { name: 'hook-probe', version: '0' },
  });
}

/**
 * Records one `task.progressed` event through the named product entry.
 * `append` and `batch_append` are the two event actions that start hooks.
 */
async function recordProgress(
  entry: Entry,
  ctx: DispatchContext,
  action: EventAction,
): Promise<{ readonly success: boolean; readonly detail: string }> {
  const event = {
    type: 'task.progressed',
    data: { taskId: 'task-1', tddPhase: 'green' },
  };
  const result = entry === 'cli'
    ? await invokeContractAction(
      action === 'append' ? 'exarchos_event.append' : 'exarchos_event.batch_append',
      action === 'append'
        ? { stream: STREAM_ID, event }
        : { stream: STREAM_ID, events: [event] },
      ctx,
    )
    : await dispatch(
      'exarchos_event',
      action === 'append'
        ? { action: 'append', stream: STREAM_ID, event }
        : { action: 'batch_append', stream: STREAM_ID, events: [event] },
      ctx,
    );
  return {
    success: result.success,
    detail: JSON.stringify(result.error ?? result.data),
  };
}

/**
 * Reads the marker when it appears before the time limit.
 * An empty file returns a fixed token. A missing file returns undefined.
 * The hook runner starts the child and does not wait for the child to exit.
 */
async function readMarker(marker: string): Promise<string | undefined> {
  const started = Date.now();
  while (Date.now() - started < MARKER_WAIT_MS) {
    if (existsSync(marker)) return markerText(marker);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(marker)) return undefined;
  return markerText(marker);
}

/** The marker text, or a fixed token when the file is empty. */
function markerText(marker: string): string {
  const text = readFileSync(marker, 'utf8');
  return text.length === 0 ? '<empty>' : text;
}

/**
 * Writes `.exarchos.yml` with one `task.progressed` hook and records the event.
 * The command callback receives the absolute marker path.
 */
async function recordHook(
  scratch: { dirs: string[]; ctx?: DispatchContext },
  entry: Entry,
  action: EventAction,
  commandFor: (marker: string) => Promise<string>,
): Promise<{ readonly success: boolean; readonly detail: string; readonly marker: string }> {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'hook-project-')));
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'hook-state-')));
  scratch.dirs.push(projectRoot, stateDir);
  const marker = join(projectRoot, 'hook-marker');
  const command = await commandFor(marker);
  const yaml = [
    'hooks:',
    '  on:',
    '    task.progressed:',
    `      - command: ${JSON.stringify(command)}`,
    '',
  ].join('\n');
  await writeFile(join(projectRoot, '.exarchos.yml'), yaml, 'utf8');
  delete process.env.EXARCHOS_SKIP_HOOKS;
  scratch.ctx = await openEntry(entry, projectRoot, stateDir);
  const recorded = await recordProgress(entry, scratch.ctx, action);
  return { ...recorded, marker };
}

/**
 * Writes an executable script beside the marker and returns its command.
 * The command is the script path and the marker path, separated by a space.
 */
async function plainCommand(marker: string): Promise<string> {
  const script = join(marker, '..', 'hook.sh');
  await writeFile(script, '#!/bin/sh\ntouch "$1"\n', 'utf8');
  await chmod(script, 0o755);
  return `${script} ${marker}`;
}

/** A shell command that writes the caller stream id into the marker. */
function shellCommand(marker: string): Promise<string> {
  return Promise.resolve(`true; printf %s "$EXARCHOS_FEATURE_ID" > ${marker}`);
}

describe('untrusted project hook commands', () => {
  const scratch: { dirs: string[]; ctx?: DispatchContext } = { dirs: [] };

  afterEach(async () => {
    scratch.ctx?.eventStore.close();
    scratch.ctx = undefined;
    const pending = scratch.dirs.splice(0, scratch.dirs.length);
    for (const dir of pending) await rmrfAsync(dir);
  });

  /**
   * The project hook is a shell command for `task.progressed`.
   * The command writes the caller stream id into the marker.
   * The marker must stay absent after a successful append.
   */
  it('shell_hook_on_append_does_not_run', async () => {
    const recorded = await recordHook(scratch, 'mcp', 'append', shellCommand);
    expect(recorded.success, recorded.detail).toBe(true);
    expect(await readMarker(recorded.marker)).toBeUndefined();
  });

  /**
   * The same shell command is registered for `task.progressed`.
   * `batch_append` must not start it after a successful batch.
   */
  it('shell_hook_on_batch_append_does_not_run', async () => {
    const recorded = await recordHook(scratch, 'mcp', 'batch_append', shellCommand);
    expect(recorded.success, recorded.detail).toBe(true);
    expect(await readMarker(recorded.marker)).toBeUndefined();
  });

  /**
   * The project hook is one executable path and one marker path.
   * The command has no shell metacharacter. Append must not start it.
   */
  it('plain_hook_on_append_does_not_run', async () => {
    const recorded = await recordHook(scratch, 'cli', 'append', plainCommand);
    expect(recorded.success, recorded.detail).toBe(true);
    expect(await readMarker(recorded.marker)).toBeUndefined();
  });

  /**
   * The same plain command is registered for `task.progressed`.
   * `batch_append` from the CLI must not start it.
   */
  it('plain_hook_on_batch_append_does_not_run', async () => {
    const recorded = await recordHook(scratch, 'cli', 'batch_append', plainCommand);
    expect(recorded.success, recorded.detail).toBe(true);
    expect(await readMarker(recorded.marker)).toBeUndefined();
  });
});
