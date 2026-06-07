/**
 * installHook — the DR-8 SessionStart binding installer (#1485, task 012).
 *
 * Writes the #1485 cross-harness SessionStart binding into the Claude Code
 * agent-host settings (`<home>/.claude/settings.json`, under
 * `hooks.SessionStart[]`). The binding is a `command`-type hook that runs
 * `exarchos session-start --directive '<orientation>'` on `startup|resume`; the
 * handler echoes the directive as `additionalContext` so injection-capable hosts
 * are soft-bound to route SDLC through the `exarchos_*` MCP tools (see
 * `cli-commands/session-start.ts` and `hooks/hooks.json`).
 *
 * Idempotent by construction: the binding is identified by a `command` that
 * references `exarchos session-start`. Re-running finds the existing entry and
 * is a no-op — exactly one registration survives any number of installs (DR-8
 * acceptance: "re-running leaves exactly one hook registration").
 *
 * This is the real impl behind {@link ApplyCtx.installHook} (the reconciler's
 * `hook`-step seam). `--no-hooks` neutralizes it upstream in `buildApplyCtx`
 * (task 010), so this installer always WRITES — the opt-out never reaches here.
 *
 * Read-modify-write with atomic tmp+rename (mirrors the init claude-code writer)
 * so a crash mid-write never leaves a half-serialized settings.json. Other host
 * keys in settings.json are preserved verbatim.
 */

import { join, dirname } from 'node:path';
import type { ApplyCtx } from '../../core/onboarding/reconcile.js';
import type { PlanStep } from '../../core/onboarding/types.js';
import type { WriterDeps } from '../init/probes.js';

/**
 * The host-relative path of the Claude Code user settings file the binding is
 * written into. Joined onto `writerDeps.home()` (the agent-host home) to form
 * the absolute target. Exported so the doctor check and tests target the same
 * location without re-deriving the literal.
 */
export const SESSION_START_SETTINGS_PATH = join('.claude', 'settings.json');

/**
 * The orientation directive baked into the binding command. Kept in lock-step
 * with the rendered `hooks/hooks.json` SessionStart directive (the build-time
 * artifact) so the installed binding and the shipped plugin hook orient the
 * harness identically.
 */
const ORIENTATION_DIRECTIVE =
  'This project uses **Exarchos** for SDLC / process management. Route workflow ' +
  'operations — ideation, planning, delegation, review, synthesis — through the ' +
  'Exarchos MCP tools (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, ' +
  '`exarchos_view`). The Exarchos event store is the source of truth for workflow ' +
  'state; do not improvise process state via ad-hoc files.';

/** The exact command the binding runs. The substring `exarchos session-start`
 * is the stable idempotence + detection marker (the doctor check keys on it). */
const BINDING_COMMAND = `exarchos session-start --directive '${ORIENTATION_DIRECTIVE}'`;

/** The SessionStart matcher: fire on both fresh starts and resumes. */
const BINDING_MATCHER = 'startup|resume';

// ─── settings.json shapes (narrow — other keys are preserved opaque) ──────────

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
  hooks?: { SessionStart?: HookGroup[]; [event: string]: unknown };
  [key: string]: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isMissingPathError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: string }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Read the host settings, tolerating a missing or unreadable file by returning
 * an empty object — a fresh repo has no settings.json yet, and a malformed one
 * must not crash onboard. (A parse failure is treated as "no binding present",
 * so the installer rewrites a clean settings object rather than throwing.)
 */
async function readSettings(deps: WriterDeps, settingsPath: string): Promise<HostSettings> {
  let raw: string;
  try {
    raw = await deps.fs.readFile(settingsPath);
  } catch (err) {
    if (isMissingPathError(err)) return {};
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as HostSettings;
    }
    return {};
  } catch {
    return {};
  }
}

/** Does any SessionStart command hook already reference the exarchos binding? */
export function hasExarchosBinding(settings: HostSettings): boolean {
  const groups = settings.hooks?.SessionStart;
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    const inner = group?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (typeof h?.command === 'string' && h.command.includes('exarchos session-start')) {
        return true;
      }
    }
  }
  return false;
}

/** Build the canonical SessionStart binding group. */
function buildBindingGroup(): HookGroup {
  return {
    matcher: BINDING_MATCHER,
    hooks: [{ type: 'command', command: BINDING_COMMAND, timeout: 10 }],
  };
}

/**
 * Insert the binding into a settings object WITHOUT mutating the input. Other
 * `hooks.*` events and all top-level keys are preserved; only a fresh
 * SessionStart group is appended.
 */
function withBinding(settings: HostSettings): HostSettings {
  const existingHooks = settings.hooks ?? {};
  const existingSessionStart = Array.isArray(existingHooks.SessionStart)
    ? existingHooks.SessionStart
    : [];
  return {
    ...settings,
    hooks: {
      ...existingHooks,
      SessionStart: [...existingSessionStart, buildBindingGroup()],
    },
  };
}

/** Atomic JSON write: serialize → write `${path}.tmp` → rename to `${path}`. */
async function atomicWriteJson(
  deps: WriterDeps,
  path: string,
  data: unknown,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await deps.fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await deps.fs.rename(tmp, path);
}

// ─── Installer ──────────────────────────────────────────────────────────────

/**
 * Install the #1485 SessionStart binding into the agent-host settings.
 *
 * Idempotent: if a binding referencing `exarchos session-start` is already
 * present, returns without writing (no duplicate registration). Otherwise
 * appends the canonical binding group and writes atomically.
 *
 * Conforms to the {@link ApplyCtx.installHook} seam signature `(step, ctx)`. The
 * `step` is unused today (a single SessionStart binding is the only hook kind);
 * it is accepted so the seam stays stable as future hook kinds fold in.
 */
export async function installHook(_step: PlanStep, ctx: ApplyCtx): Promise<void> {
  const deps = ctx.writerDeps;
  const home = deps.home();
  const settingsPath = join(home, SESSION_START_SETTINGS_PATH);

  const settings = await readSettings(deps, settingsPath);
  if (hasExarchosBinding(settings)) {
    // Already registered — idempotent no-op (DR-8: exactly one entry).
    return;
  }

  const next = withBinding(settings);
  await deps.fs.mkdir(dirname(settingsPath), { recursive: true });
  await atomicWriteJson(deps, settingsPath, next);
}
