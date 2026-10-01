/**
 * The agent-host lifecycle-hook seam behind {@link ApplyCtx.installHook}. The `key` of the plan step selects one of two paths.
 * The install path writes the SessionStart, SessionEnd and SubagentStop bindings into `<home>/.claude/settings.json`.
 * The uninstall path, {@link removeRetiredHooks}, removes the retired SessionStart directive and SessionEnd observer, because the launcher owns session lifecycle.
 * SubagentStop stays, because it feeds token attribution.
 *
 * A command marker identifies each binding, so a second run adds nothing.
 * `--no-hooks` disables the seam upstream in `buildApplyCtx`, so this installer always writes.
 * Writes are atomic with a temporary file and a rename, and other settings keys stay unchanged.
 */

import { join, dirname } from 'node:path';
import type { ApplyCtx } from '../../dispatch/core/onboarding/reconcile.js';
import type { PlanStep } from '../../dispatch/core/onboarding/types.js';
import type { WriterDeps } from '../init/probes.js';
import { publishTempFile } from '../../utils/atomic-write.js';

/** Path of the Claude Code user settings file, relative to `writerDeps.home()`. The doctor check and tests use the same export. */
export const SESSION_START_SETTINGS_PATH = join('.claude', 'settings.json');

/** The orientation directive in the binding command. It must match the SessionStart directive in the rendered `hooks/hooks.json`. */
const ORIENTATION_DIRECTIVE =
  'This project uses **Exarchos** for SDLC / process management. Route workflow ' +
  'operations — ideation, planning, delegation, review, synthesis — through the ' +
  'Exarchos MCP tools (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, ' +
  '`exarchos_view`). The Exarchos event store is the source of truth for workflow ' +
  'state; do not improvise process state via ad-hoc files.';

/** The SessionStart binding command. Its substring `exarchos session-start` is the marker that the installer and the doctor check detect. */
const BINDING_COMMAND = `exarchos session-start --directive '${ORIENTATION_DIRECTIVE}'`;

/** The SessionStart matcher: fire on both fresh starts and resumes. */
const BINDING_MATCHER = 'startup|resume';

/** The Claude Code hook events this installer binds. */
type HookEventName = 'SessionStart' | 'SessionEnd' | 'SubagentStop';

/** Detection marker for each event, as a substring of the bound command. */
const SESSION_START_MARKER = 'exarchos session-start';
const SESSION_END_MARKER = 'exarchos session-end';
const SUBAGENT_STOP_MARKER = 'exarchos subagent-stop';

/**
 * The doctor-check and plan-step key for the retired-hooks finding.
 * The check uses it as its `name`, `CHECK_CLASSIFICATION` maps it to the `hook` step, and `installHook` sends it to {@link removeRetiredHooks}.
 */
export const RETIRED_HOOKS_CHECK_NAME = 'retired-hooks-present';

/**
 * Command markers of the retired hooks: the SessionStart directive and the SessionEnd observer.
 * They are the same markers that the installer writes, so removal touches only a hook whose command contains one of them. SubagentStop is not in the set.
 */
export const RETIRED_HOOK_MARKERS: readonly string[] = [
  SESSION_START_MARKER,
  SESSION_END_MARKER,
];

/** Whether a hook `command` contains a retired marker. */
function commandIsRetired(command: unknown): boolean {
  return typeof command === 'string' && RETIRED_HOOK_MARKERS.some((m) => command.includes(m));
}

interface BindingSpec {
  readonly event: HookEventName;
  readonly matcher: string;
  readonly command: string;
  /** Detection marker. It must be a substring of `command`. */
  readonly marker: string;
  readonly timeout: number;
}

/** The bindings the installer writes, in hooks.json order. */
const BINDINGS: readonly BindingSpec[] = [
  {
    event: 'SessionStart',
    matcher: BINDING_MATCHER,
    command: BINDING_COMMAND,
    marker: SESSION_START_MARKER,
    timeout: 10,
  },
  {
    event: 'SessionEnd',
    matcher: 'auto',
    command: 'exarchos session-end',
    marker: SESSION_END_MARKER,
    timeout: 30,
  },
  {
    event: 'SubagentStop',
    matcher: '*',
    command: 'exarchos subagent-stop',
    marker: SUBAGENT_STOP_MARKER,
    timeout: 30,
  },
];

interface CommandHook {
  readonly type?: string;
  readonly command?: string;
  readonly timeout?: number;
}

interface HookGroup {
  readonly matcher?: string;
  readonly hooks?: CommandHook[];
}

interface HostSettings {
  hooks?: {
    SessionStart?: HookGroup[];
    SessionEnd?: HookGroup[];
    SubagentStop?: HookGroup[];
    [event: string]: unknown;
  } | undefined;
  [key: string]: unknown;
}

function isMissingPathError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: string }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Reads the host settings. An absent file (ENOENT or ENOTDIR) gives `{}`.
 * It throws for an unreadable file, for invalid JSON, and for a JSON value that is not an object.
 * It does not return `{}` for these cases, because the caller then replaces the user settings with only the bindings.
 * `applyHookStep` catches the throw, leaves the step residual, and keeps the user file unchanged.
 */
async function readSettings(deps: WriterDeps, settingsPath: string): Promise<HostSettings> {
  let raw: string;
  try {
    raw = await deps.fs.readFile(settingsPath);
  } catch (err) {
    if (isMissingPathError(err)) return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${settingsPath}; refusing to overwrite existing settings.`,
      { cause: err },
    );
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as HostSettings;
  }
  throw new Error(
    `${settingsPath} is not a JSON object; refusing to overwrite existing settings.`,
  );
}

/** Whether `event` already has a command hook whose command contains `marker`. */
function hasBinding(settings: HostSettings, event: HookEventName, marker: string): boolean {
  const groups = settings.hooks?.[event];
  if (!Array.isArray(groups)) return false;
  for (const group of groups as HookGroup[]) {
    const inner = group?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (typeof h?.command === 'string' && h.command.includes(marker)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether a parsed settings object has a command hook with a retired marker, under any event.
 * The `retired-hooks-present` doctor check uses it, and it uses the same marker test as {@link stripRetiredBindings}.
 * It accepts `unknown`, so the doctor check can pass parsed JSON without a cast.
 */
export function settingsHasRetiredHooks(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false;
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (typeof hooks !== 'object' || hooks === null) return false;
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups as HookGroup[]) {
      const inner = group?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (commandIsRetired(h?.command)) return true;
      }
    }
  }
  return false;
}

/** Returns a copy of the settings with a new group for `spec.event` appended. Other events, existing groups and top-level keys stay. */
function withBindingFor(settings: HostSettings, spec: BindingSpec): HostSettings {
  const existingHooks = settings.hooks ?? {};
  const existingGroups = Array.isArray(existingHooks[spec.event])
    ? (existingHooks[spec.event] as HookGroup[])
    : [];
  const group: HookGroup = {
    matcher: spec.matcher,
    hooks: [{ type: 'command', command: spec.command, timeout: spec.timeout }],
  };
  return {
    ...settings,
    hooks: { ...existingHooks, [spec.event]: [...existingGroups, group] },
  };
}

/** Writes JSON atomically: it writes `${path}.tmp`, then renames it to `${path}`. */
async function atomicWriteJson(
  deps: WriterDeps,
  path: string,
  data: unknown,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await deps.fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await publishTempFile(tmp, path, { rename: (from, to) => deps.fs.rename(from, to) });
}

/**
 * Installs the SessionStart, SessionEnd and SubagentStop bindings, the same set as the plugin `hooks.json`.
 * SubagentStop feeds per-subagent token attribution through `subagent.tokens_used`.
 * It skips a binding whose marker is present, and writes the file once only when it adds a binding.
 */
async function installBindings(ctx: ApplyCtx): Promise<void> {
  const deps = ctx.writerDeps;
  const home = deps.home();
  const settingsPath = join(home, SESSION_START_SETTINGS_PATH);

  const settings = await readSettings(deps, settingsPath);

  let next = settings;
  let changed = false;
  for (const spec of BINDINGS) {
    if (hasBinding(next, spec.event, spec.marker)) {
      continue;
    }
    next = withBindingFor(next, spec);
    changed = true;
  }

  if (!changed) {
    return;
  }

  await deps.fs.mkdir(dirname(settingsPath), { recursive: true });
  await atomicWriteJson(deps, settingsPath, next);
}

/**
 * Entry point of the {@link ApplyCtx.installHook} seam.
 * The key {@link RETIRED_HOOKS_CHECK_NAME} goes to {@link removeRetiredHooks}, and every other key goes to {@link installBindings}.
 * The install or remove decision stays here, outside the pure reconciler.
 */
export async function installHook(step: PlanStep, ctx: ApplyCtx): Promise<void> {
  if (step.key === RETIRED_HOOKS_CHECK_NAME) {
    return removeRetiredHooks(step, ctx);
  }
  return installBindings(ctx);
}

/**
 * Returns a copy of the settings without the command hooks that carry a retired marker. The input does not change.
 * A group that the removal empties is dropped, and an event that the removal leaves with no groups is dropped.
 * An event that was an empty array already keeps its key. Values that are not groups stay unchanged.
 * The `removed` flag lets the caller skip the write when nothing matched.
 */
function stripRetiredBindings(settings: HostSettings): { next: HostSettings; removed: boolean } {
  const hooks = settings.hooks;
  if (typeof hooks !== 'object' || hooks === null) return { next: settings, removed: false };

  let removed = false;
  const nextHooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups;
      continue;
    }
    const nextGroups: HookGroup[] = [];
    for (const group of groups as HookGroup[]) {
      const inner = group?.hooks;
      if (!Array.isArray(inner)) {
        nextGroups.push(group);
        continue;
      }
      const kept = inner.filter((h) => {
        if (commandIsRetired(h?.command)) {
          removed = true;
          return false;
        }
        return true;
      });
      if (kept.length === inner.length) {
        nextGroups.push(group);
      } else if (kept.length > 0) {
        nextGroups.push({ ...group, hooks: kept });
      }
    }
    if (nextGroups.length > 0 || groups.length === 0) {
      nextHooks[event] = nextGroups;
    }
  }

  if (!removed) return { next: settings, removed: false };
  return { next: { ...settings, hooks: nextHooks as HostSettings['hooks'] }, removed: true };
}

/**
 * Removes the retired hooks from the agent-host settings. A hook goes only when its command carries a {@link RETIRED_HOOK_MARKERS} marker.
 * When no retired hook is present, it writes nothing, so an absent settings file is a no-op.
 * An unreadable or malformed file throws through {@link readSettings}.
 * It has the `(step, ctx)` signature of the {@link ApplyCtx.installHook} seam.
 */
export async function removeRetiredHooks(_step: PlanStep, ctx: ApplyCtx): Promise<void> {
  const deps = ctx.writerDeps;
  const settingsPath = join(deps.home(), SESSION_START_SETTINGS_PATH);

  const settings = await readSettings(deps, settingsPath);
  const { next, removed } = stripRetiredBindings(settings);
  if (!removed) {
    return;
  }

  await deps.fs.mkdir(dirname(settingsPath), { recursive: true });
  await atomicWriteJson(deps, settingsPath, next);
}
