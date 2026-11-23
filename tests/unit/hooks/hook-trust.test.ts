/**
 * The binding of project hooks to a trust record in the state directory.
 * The unit cases call `bindProjectHooks` on real files. The dispatch cases load `.exarchos.yml`,
 * record `task.progressed` through the event tool, and look for the marker that the hook writes.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ResolvedProjectConfig } from '../../../src/config/resolve.js';
import { initializeContext } from '../../../src/dispatch/core/context.js';
import { dispatch, type DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { bindProjectHooks, HOOK_TRUST_FILENAME } from '../../../src/hooks/hook-trust.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const MARKER_WAIT_MS = 2000;

type HookTable = ResolvedProjectConfig['hooks']['on'];

/** Writes one trust record for `projectRoot` into the trust file of `stateDir`. */
async function writeTrust(stateDir: string, projectRoot: string, hooksDigest: string): Promise<void> {
  await writeFile(
    join(stateDir, HOOK_TRUST_FILENAME),
    JSON.stringify({ projects: { [projectRoot]: { hooksDigest } } }),
    'utf8',
  );
}

/** The digest that a trust record must hold for `on` in `projectRoot`. */
function digestFor(stateDir: string, projectRoot: string, on: HookTable): string {
  const binding = bindProjectHooks({ stateDir, projectRoot, hooks: { on } });
  if (binding.kind !== 'untrusted') throw new Error(`expected untrusted, got ${binding.kind}`);
  return binding.digest;
}

/** Waits for the marker and returns its text, or undefined when it does not appear in time. */
async function readMarker(marker: string): Promise<string | undefined> {
  const started = Date.now();
  while (Date.now() - started < MARKER_WAIT_MS) {
    if (existsSync(marker)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return readFileSync(marker, 'utf8');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return existsSync(marker) ? readFileSync(marker, 'utf8') : undefined;
}

const dirs: string[] = [];
const contexts: DispatchContext[] = [];

/** A fresh state directory and a fresh project root with a real path. */
function scratch(): { stateDir: string; projectRoot: string } {
  const stateDir = makeTempDir('hook-trust-state-');
  const projectRoot = realpathSync(makeTempDir('hook-trust-project-'));
  dirs.push(stateDir, projectRoot);
  return { stateDir, projectRoot };
}

/**
 * Writes a project with one `task.progressed` hook that runs `hook.sh`.
 * The script writes each argument and `EXARCHOS_FEATURE_ID` into the marker, each one followed by a bar.
 */
async function hookProject(): Promise<{ stateDir: string; projectRoot: string; marker: string }> {
  const { stateDir, projectRoot } = scratch();
  const marker = join(projectRoot, 'hook-marker');
  await writeFile(
    join(projectRoot, 'hook.sh'),
    '#!/bin/sh\nprintf "%s|" "$@" "$EXARCHOS_FEATURE_ID" > hook-marker\n',
    'utf8',
  );
  await chmod(join(projectRoot, 'hook.sh'), 0o755);
  await writeConfig(projectRoot, './hook.sh one "two words"');
  return { stateDir, projectRoot, marker };
}

/** Writes `.exarchos.yml` with one `task.progressed` hook. */
async function writeConfig(projectRoot: string, command: string): Promise<void> {
  await writeFile(
    join(projectRoot, '.exarchos.yml'),
    ['hooks:', '  on:', '    task.progressed:', `      - command: ${JSON.stringify(command)}`, ''].join('\n'),
    'utf8',
  );
}

/** Records `task.progressed` through the event tool and returns the result. */
async function record(ctx: DispatchContext, stream: string): Promise<boolean> {
  const result = await dispatch(
    'exarchos_event',
    { action: 'append', stream, event: { type: 'task.progressed', data: { taskId: 't1', tddPhase: 'green' } } },
    ctx,
  );
  return result.success;
}

/** The digest for the hook of `.exarchos.yml`, as an untrusted context reports it. */
function configDigest(stateDir: string, projectRoot: string): string {
  return digestFor(stateDir, projectRoot, {
    'task.progressed': [{ command: './hook.sh one "two words"', timeout: 30000 }],
  });
}

describe('bindProjectHooks', () => {
  afterEach(async () => {
    for (const ctx of contexts.splice(0, contexts.length)) ctx.eventStore.close();
    for (const dir of dirs.splice(0, dirs.length)) await rmrfAsync(dir);
  });

  it('NoHooks_BindsNone', () => {
    const { stateDir, projectRoot } = scratch();
    const binding = bindProjectHooks({ stateDir, projectRoot, hooks: { on: { 'task.progressed': [] } } });
    expect(binding.kind).toBe('none');
    expect(binding.hooks.on).toEqual({});
  });

  it('NoTrustRecord_BindsEmptyTable', () => {
    const { stateDir, projectRoot } = scratch();
    const binding = bindProjectHooks({
      stateDir,
      projectRoot,
      hooks: { on: { 'task.progressed': [{ command: './hook.sh', timeout: 30000 }] } },
    });
    expect(binding.kind).toBe('untrusted');
    expect(binding.hooks.on).toEqual({});
    if (binding.kind !== 'untrusted') return;
    expect(binding.trustFile).toBe(join(stateDir, HOOK_TRUST_FILENAME));
    expect(binding.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('MatchingTrustRecord_BindsArgv', async () => {
    const { stateDir, projectRoot } = scratch();
    const on: HookTable = { 'task.progressed': [{ command: './hook.sh --msg "a b"', timeout: 5000 }] };
    await writeTrust(stateDir, projectRoot, digestFor(stateDir, projectRoot, on));

    const binding = bindProjectHooks({ stateDir, projectRoot, hooks: { on } });

    expect(binding.kind).toBe('trusted');
    expect(binding.hooks.projectRoot).toBe(projectRoot);
    expect(binding.hooks.on).toEqual({
      'task.progressed': [{ argv: ['./hook.sh', '--msg', 'a b'], timeout: 5000 }],
    });
  });

  it('ChangedCommandAfterTrust_BindsEmptyTable', async () => {
    const { stateDir, projectRoot } = scratch();
    const trustedOn: HookTable = { 'task.progressed': [{ command: './hook.sh', timeout: 5000 }] };
    await writeTrust(stateDir, projectRoot, digestFor(stateDir, projectRoot, trustedOn));

    for (const on of [
      { 'task.progressed': [{ command: './other.sh', timeout: 5000 }] },
      { 'task.progressed': [{ command: './hook.sh extra', timeout: 5000 }] },
      { 'task.progressed': [{ command: './hook.sh', timeout: 6000 }] },
      { 'task.completed': [{ command: './hook.sh', timeout: 5000 }] },
      {
        'task.progressed': [{ command: './hook.sh', timeout: 5000 }],
        'task.completed': [{ command: './other.sh', timeout: 5000 }],
      },
    ] satisfies HookTable[]) {
      const binding = bindProjectHooks({ stateDir, projectRoot, hooks: { on } });
      expect(binding.kind).toBe('untrusted');
      expect(binding.hooks.on).toEqual({});
    }
  });

  it('TrustRecordForOtherRoot_BindsEmptyTable', async () => {
    const first = scratch();
    const second = scratch();
    const on: HookTable = { 'task.progressed': [{ command: './hook.sh', timeout: 5000 }] };
    await writeTrust(first.stateDir, first.projectRoot, digestFor(first.stateDir, first.projectRoot, on));

    const binding = bindProjectHooks({ stateDir: first.stateDir, projectRoot: second.projectRoot, hooks: { on } });

    expect(binding.kind).toBe('untrusted');
  });

  it('DigestFromOtherRoot_DoesNotTrust', async () => {
    const first = scratch();
    const second = scratch();
    const on: HookTable = { 'task.progressed': [{ command: './hook.sh', timeout: 5000 }] };
    await writeTrust(first.stateDir, second.projectRoot, digestFor(first.stateDir, first.projectRoot, on));

    const binding = bindProjectHooks({ stateDir: first.stateDir, projectRoot: second.projectRoot, hooks: { on } });

    expect(binding.kind).toBe('untrusted');
  });

  it('SymlinkedRoot_UsesRealPath', async () => {
    const { stateDir, projectRoot } = scratch();
    const linkParent = makeTempDir('hook-trust-link-');
    dirs.push(linkParent);
    const link = join(linkParent, 'project');
    await symlink(projectRoot, link);
    const on: HookTable = { 'task.progressed': [{ command: './hook.sh', timeout: 5000 }] };
    await writeTrust(stateDir, projectRoot, digestFor(stateDir, projectRoot, on));

    const binding = bindProjectHooks({ stateDir, projectRoot: link, hooks: { on } });

    expect(binding.kind).toBe('trusted');
    expect(binding.hooks.projectRoot).toBe(projectRoot);
  });

  it('TrustFileInsideProject_DoesNotTrust', async () => {
    const { stateDir, projectRoot } = scratch();
    const on: HookTable = { 'task.progressed': [{ command: './hook.sh', timeout: 5000 }] };
    const digest = digestFor(stateDir, projectRoot, on);
    await writeTrust(projectRoot, projectRoot, digest);
    await mkdir(join(projectRoot, '.exarchos'), { recursive: true });
    await writeTrust(join(projectRoot, '.exarchos'), projectRoot, digest);

    const binding = bindProjectHooks({ stateDir, projectRoot, hooks: { on } });

    expect(binding.kind).toBe('untrusted');
  });

  it('MalformedTrustFile_DoesNotTrust', async () => {
    const { stateDir, projectRoot } = scratch();
    const on: HookTable = { 'task.progressed': [{ command: './hook.sh', timeout: 5000 }] };
    const digest = digestFor(stateDir, projectRoot, on);
    for (const body of [
      'not json',
      'null',
      JSON.stringify([digest]),
      JSON.stringify({ projects: [] }),
      JSON.stringify({ projects: { [projectRoot]: digest } }),
      JSON.stringify({ projects: { [projectRoot]: { hooksDigest: 1 } } }),
    ]) {
      await writeFile(join(stateDir, HOOK_TRUST_FILENAME), body, 'utf8');
      expect(bindProjectHooks({ stateDir, projectRoot, hooks: { on } }).kind).toBe('untrusted');
    }
  });

  it('ShellMetacharacters_RefusedEvenWithRecord', async () => {
    const { stateDir, projectRoot } = scratch();
    for (const command of [
      'true; touch /tmp/x',
      'printf %s "$EXARCHOS_FEATURE_ID" > marker',
      'a | b',
      'a && b',
      '$(id)',
      '`id`',
      'a\nb',
      '"unterminated',
      '   ',
    ]) {
      const binding = bindProjectHooks({
        stateDir,
        projectRoot,
        hooks: { on: { 'task.progressed': [{ command, timeout: 5000 }] } },
      });
      expect(binding.kind, command).toBe('invalid');
      expect(binding.hooks.on).toEqual({});
    }
  });

  it('BoundHooks_DoNotFollowLaterChanges', async () => {
    const { stateDir, projectRoot } = scratch();
    const action = { command: './hook.sh', timeout: 5000 };
    const on: Record<string, { command: string; timeout: number }[]> = { 'task.progressed': [action] };
    await writeTrust(stateDir, projectRoot, digestFor(stateDir, projectRoot, on));

    const binding = bindProjectHooks({ stateDir, projectRoot, hooks: { on } });
    action.command = './other.sh';
    on['task.completed'] = [{ command: './other.sh', timeout: 5000 }];

    expect(binding.kind).toBe('trusted');
    expect(binding.hooks.on).toEqual({
      'task.progressed': [{ argv: ['./hook.sh'], timeout: 5000 }],
    });
    expect(Object.isFrozen(binding.hooks.on)).toBe(true);
    expect(Object.isFrozen(binding.hooks.on['task.progressed']?.[0]?.argv)).toBe(true);
  });

  it('Dispatch_TrustedHook_RunsWithoutShell', async () => {
    delete process.env.EXARCHOS_SKIP_HOOKS;
    const { stateDir, projectRoot, marker } = await hookProject();
    await writeTrust(stateDir, projectRoot, configDigest(stateDir, projectRoot));

    const ctx = await initializeContext(stateDir, { projectRoot });
    contexts.push(ctx);

    expect(await record(ctx, 'feature-a')).toBe(true);
    expect(await readMarker(marker)).toBe('one|two words|feature-a|');
  });

  it('Dispatch_HookChangedAfterTrust_DoesNotRun', async () => {
    delete process.env.EXARCHOS_SKIP_HOOKS;
    const { stateDir, projectRoot, marker } = await hookProject();
    await writeTrust(stateDir, projectRoot, configDigest(stateDir, projectRoot));
    await writeConfig(projectRoot, `./hook.sh ${marker}`);

    const ctx = await initializeContext(stateDir, { projectRoot });
    contexts.push(ctx);

    expect(await record(ctx, 'feature-a')).toBe(true);
    expect(await readMarker(marker)).toBeUndefined();
  });

  it('Dispatch_ConfigEditedWhileOpen_RunsBoundHookOnly', async () => {
    delete process.env.EXARCHOS_SKIP_HOOKS;
    const { stateDir, projectRoot, marker } = await hookProject();
    await writeTrust(stateDir, projectRoot, configDigest(stateDir, projectRoot));

    const ctx = await initializeContext(stateDir, { projectRoot });
    contexts.push(ctx);
    await writeConfig(projectRoot, './hook.sh changed');

    expect(await record(ctx, 'feature-a')).toBe(true);
    expect(await readMarker(marker)).toBe('one|two words|feature-a|');
  });
});
