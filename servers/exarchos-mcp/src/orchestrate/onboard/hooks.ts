/**
 * installHook — the agent-host lifecycle-hook seam (#1485, task 012 + DR-7).
 *
 * One `hook` seam, two populations dispatched by the plan step's `key`:
 *   - the #1485 SessionStart/SessionEnd/SubagentStop binding INSTALL (below), and
 *   - the DR-7 retired-hook UNINSTALL ({@link removeRetiredHooks}) — the launcher
 *     now owns session lifecycle, so the onboard-installed SessionStart directive
 *     and SessionEnd observer are retired while SubagentStop (token attribution)
 *     is retained.
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
import { publishTempFile } from '../../utils/atomic-write.js';

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

// ─── Binding specs — symmetric with the plugin's hooks/hooks.json (#1572 Gap-1)─
//
// The plugin ships SessionStart + SessionEnd + SubagentStop in hooks/hooks.json,
// so PLUGIN consumers get all three. STANDALONE-CLI consumers go through this
// installer, which historically wrote only SessionStart (#1485) — so they got
// no SessionEnd / SubagentStop bindings, and therefore no per-subagent token
// attribution (the SubagentStop binding is the seam that feeds
// `subagent.tokens_used`, #1561/#1525). #1572 Gap-1 closes that asymmetry: the
// installer now writes all three, each idempotent on its own command marker.
//
// INV-4 posture: all three are Claude-Code agent-host hook events written into
// the Claude-Code settings path; the binding is host-specific by construction
// exactly as the original SessionStart binding always was — no per-binding
// runtime-capability probe is introduced (and none exists), so the symmetry is
// "write the same three the plugin declares for this host", nothing more.

/** The Claude Code hook events this installer binds. */
type HookEventName = 'SessionStart' | 'SessionEnd' | 'SubagentStop';

/** Per-event idempotence/detection markers (substring of the bound command). */
const SESSION_START_MARKER = 'exarchos session-start';
const SESSION_END_MARKER = 'exarchos session-end';
const SUBAGENT_STOP_MARKER = 'exarchos subagent-stop';

// ─── Retired-hook provenance (DR-7) ───────────────────────────────────────────
//
// DR-7 makes the launcher the lifecycle authority: session lifecycle is sourced
// from `launch.*` events, so the onboard-installed SessionStart *directive* and
// the SessionEnd observer are RETIRED. SubagentStop is RETAINED — it is the
// token-attribution seam that feeds `subagent.tokens_used` (#1561/#1525), so its
// marker is deliberately absent from the retired set below and `removeRetiredHooks`
// never touches it.
//
// The retired set reuses the EXACT command markers the installer writes, so
// removal is command-marker provenance-matched — never a heuristic and never a
// second copy of the marker text (INV-4). USER-authored hooks (any command NOT
// carrying one of these markers) are provably outside this set.

/** The doctor-check / plan-step key for the retired-hooks-present finding (DR-7).
 * The check keys its `name` here, `CHECK_CLASSIFICATION` maps it to the `hook`
 * removal step, and `installHook` dispatches this key to {@link removeRetiredHooks}
 * — one string, one source of truth, so the three never drift. */
export const RETIRED_HOOKS_CHECK_NAME = 'retired-hooks-present';

/** Command markers of the hooks DR-7 retires from onboard-installed settings:
 * the SessionStart directive + the SessionEnd observer. SubagentStop is retained
 * (token attribution) and intentionally excluded. */
export const RETIRED_HOOK_MARKERS: readonly string[] = [
  SESSION_START_MARKER,
  SESSION_END_MARKER,
];

/** Does a hook `command` carry a retired provenance marker (command-marker match)? */
function commandIsRetired(command: unknown): boolean {
  return typeof command === 'string' && RETIRED_HOOK_MARKERS.some((m) => command.includes(m));
}

interface BindingSpec {
  readonly event: HookEventName;
  readonly matcher: string;
  readonly command: string;
  /** Idempotence + detection marker (must be a substring of `command`). */
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
  hooks?: {
    SessionStart?: HookGroup[];
    SessionEnd?: HookGroup[];
    SubagentStop?: HookGroup[];
    [event: string]: unknown;
  };
  [key: string]: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isMissingPathError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: string }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Read the host settings. A genuinely ABSENT file (ENOENT/ENOTDIR) is the
 * fresh-repo case and safely yields `{}` — there is nothing to lose. But a file
 * that EXISTS and is unreadable (e.g. EACCES) or malformed (invalid JSON) must
 * NOT collapse to `{}`: the caller would then atomically rewrite the file with
 * only the binding, silently discarding the user's existing settings. That is
 * exactly the destructive overwrite INV-14 forbids (refuse-to-discard — never
 * overwrite work we could not first read). So we re-throw on a non-missing read
 * error and on a parse failure; `applyHookStep` catches the throw and leaves the
 * step residual with an advisory (forward-only), preserving the user's file
 * byte-for-byte.
 */
async function readSettings(deps: WriterDeps, settingsPath: string): Promise<HostSettings> {
  let raw: string;
  try {
    raw = await deps.fs.readFile(settingsPath);
  } catch (err) {
    if (isMissingPathError(err)) return {};
    // INV-14: a present-but-unreadable file is not "no settings" — refuse rather
    // than overwrite work we cannot read back.
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // INV-14: malformed JSON is a present file with content — preserve it.
    throw new Error(
      `Invalid JSON in ${settingsPath}; refusing to overwrite existing settings.`,
      { cause: err },
    );
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as HostSettings;
  }
  // A non-object JSON value (array / scalar) at the settings path is just as
  // unsafe to clobber as malformed JSON — refuse rather than overwrite.
  throw new Error(
    `${settingsPath} is not a JSON object; refusing to overwrite existing settings.`,
  );
}

/** Does `event` already carry a command hook whose command includes `marker`? */
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
 * Does a (possibly-untrusted) parsed settings object carry ANY provenance-matched
 * retired hook (DR-7)? Scans every hook event group for a command hook whose
 * command carries a retired marker — command-marker provenance only. Shared by
 * the `retired-hooks-present` doctor check (which decides remediable-vs-Pass) and
 * {@link stripRetiredBindings} (which decides what to remove), so the check and
 * the remover agree on the population by construction. Accepts `unknown` so the
 * doctor check can hand it a freshly-parsed settings blob without a cast.
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

/**
 * Insert one binding into a settings object WITHOUT mutating the input. Other
 * `hooks.*` events, existing groups for the SAME event, and all top-level keys
 * are preserved; only a fresh group for `spec.event` is appended.
 */
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

/** Atomic JSON write: serialize → write `${path}.tmp` → rename to `${path}`. */
async function atomicWriteJson(
  deps: WriterDeps,
  path: string,
  data: unknown,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await deps.fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await publishTempFile(tmp, path, { rename: (from, to) => deps.fs.rename(from, to) });
}

// ─── Installer ──────────────────────────────────────────────────────────────

/**
 * Install the cross-harness Exarchos bindings into the agent-host settings:
 * SessionStart (#1485), plus SessionEnd and SubagentStop (#1572 Gap-1) so a
 * standalone-CLI host is symmetric with the plugin's hooks.json — the
 * SubagentStop binding is what enables per-subagent token attribution
 * (`subagent.tokens_used`, #1561/#1525).
 *
 * Idempotent per-binding: each event whose command marker is already present is
 * skipped, so re-running leaves exactly one registration per binding and a host
 * that already has a subset gets only the missing ones. The file is written once
 * (atomically) iff at least one binding was added.
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
      continue; // already registered — idempotent per-binding no-op
    }
    next = withBindingFor(next, spec);
    changed = true;
  }

  if (!changed) {
    return; // every binding already present — nothing to write
  }

  await deps.fs.mkdir(dirname(settingsPath), { recursive: true });
  await atomicWriteJson(deps, settingsPath, next);
}

/**
 * The {@link ApplyCtx.installHook} seam entry point. One `hook` seam drives two
 * DR-7 populations, dispatched by the step's stable `key`:
 *   - {@link RETIRED_HOOKS_CHECK_NAME} → {@link removeRetiredHooks} (DR-7 uninstall
 *     of the launcher-superseded lifecycle bindings);
 *   - anything else (the #1485 `session-start-hook` step) → {@link installBindings}.
 *
 * Keeping a single seam means `reconcile.apply` routes every `hook` step through
 * one hook, and the install-vs-remove decision stays here in the hooks domain
 * rather than leaking into the pure reconciler.
 */
export async function installHook(step: PlanStep, ctx: ApplyCtx): Promise<void> {
  if (step.key === RETIRED_HOOKS_CHECK_NAME) {
    return removeRetiredHooks(step, ctx);
  }
  return installBindings(ctx);
}

// ─── Retired-hook uninstall (DR-7) ─────────────────────────────────────────────

/**
 * Strip every provenance-matched retired hook from a settings object WITHOUT
 * mutating the input. A command hook whose command carries a retired marker is
 * dropped; a group emptied by that removal is dropped; an event left with no
 * groups is dropped. Everything else — user-authored hooks, the retained
 * SubagentStop binding, other groups for the same event, and all top-level keys —
 * is preserved verbatim. Returns the (possibly-new) settings plus whether any
 * hook was removed, so the caller can skip the write entirely when nothing
 * matched (idempotent no-op).
 */
function stripRetiredBindings(settings: HostSettings): { next: HostSettings; removed: boolean } {
  const hooks = settings.hooks;
  if (typeof hooks !== 'object' || hooks === null) return { next: settings, removed: false };

  let removed = false;
  const nextHooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups; // opaque / non-group value preserved verbatim
      continue;
    }
    const nextGroups: HookGroup[] = [];
    for (const group of groups as HookGroup[]) {
      const inner = group?.hooks;
      if (!Array.isArray(inner)) {
        nextGroups.push(group); // group without a hooks array — leave as-is
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
        nextGroups.push(group); // untouched
      } else if (kept.length > 0) {
        nextGroups.push({ ...group, hooks: kept }); // some retired hooks removed
      }
      // else: the group carried ONLY retired hooks → drop the now-empty group
    }
    if (nextGroups.length > 0 || groups.length === 0) {
      // Keep the event key when it still has groups, or when it was already an
      // explicitly-empty array the user set (never synthesize/strip that).
      nextHooks[event] = nextGroups;
    }
    // else: every group under this event was dropped by removal → drop the key
  }

  if (!removed) return { next: settings, removed: false };
  return { next: { ...settings, hooks: nextHooks as HostSettings['hooks'] }, removed: true };
}

/**
 * Remove the DR-7 retired hooks (SessionStart directive + SessionEnd observer)
 * from the agent-host settings, leaving USER-authored hooks and the retained
 * SubagentStop binding untouched. Command-marker provenance match ONLY — a hook
 * is removed iff its command carries a {@link RETIRED_HOOK_MARKERS} marker.
 *
 * Idempotent: when no retired hook is present the settings are left byte-for-byte
 * (no write at all), so repeated runs are safe and a fresh/absent settings file
 * (ENOENT ⇒ `{}` via {@link readSettings}) is a clean no-op. A present-but-
 * unreadable / malformed file re-throws through {@link readSettings} (INV-14
 * refuse-to-overwrite); `applyHookStep` catches the throw, leaves the step
 * residual, and preserves the user's file.
 *
 * Conforms to the {@link ApplyCtx.installHook} seam signature `(step, ctx)`.
 */
export async function removeRetiredHooks(_step: PlanStep, ctx: ApplyCtx): Promise<void> {
  const deps = ctx.writerDeps;
  const settingsPath = join(deps.home(), SESSION_START_SETTINGS_PATH);

  const settings = await readSettings(deps, settingsPath);
  const { next, removed } = stripRetiredBindings(settings);
  if (!removed) {
    return; // no provenance-matched retired hooks — idempotent no-op, no write
  }

  await deps.fs.mkdir(dirname(settingsPath), { recursive: true });
  await atomicWriteJson(deps, settingsPath, next);
}
