import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TOOL_REGISTRY } from '../registry.js';
import type { CommandResult } from '../cli.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FilteredComposite {
  readonly name: string;
  readonly actions: readonly string[];
}

export interface FilterResult {
  readonly available: readonly FilteredComposite[];
  readonly denied: readonly FilteredComposite[];
}

// ─── Phase + Role Filtering ────────────────────────────────────────────────

/**
 * Filter the TOOL_REGISTRY actions by phase and role.
 *
 * An action is "available" when:
 *   - action.phases.has(currentPhase)
 *   - action.roles.has(role) OR action.roles.has('any')
 *
 * Everything else is "denied".
 */
export function filterToolsForPhaseAndRole(
  phase: string,
  role: string,
): FilterResult {
  const available: FilteredComposite[] = [];
  const denied: FilteredComposite[] = [];

  for (const composite of TOOL_REGISTRY) {
    const availActions: string[] = [];
    const deniedActions: string[] = [];

    for (const action of composite.actions) {
      const phaseMatch = action.phases.has(phase);
      const roleMatch = action.roles.has(role) || action.roles.has('any');

      if (phaseMatch && roleMatch) {
        availActions.push(action.name);
      } else {
        deniedActions.push(action.name);
      }
    }

    if (availActions.length > 0) {
      available.push({ name: composite.name, actions: availActions });
    }
    if (deniedActions.length > 0) {
      denied.push({ name: composite.name, actions: deniedActions });
    }
  }

  return { available, denied };
}

// ─── Output Formatting ─────────────────────────────────────────────────────

/**
 * Format tool guidance as human-readable plain text for SubagentStart injection.
 */
export function formatToolGuidance(
  available: readonly FilteredComposite[],
  denied: readonly FilteredComposite[],
): string {
  if (available.length === 0 && denied.length === 0) {
    return '';
  }

  const lines: string[] = [];

  if (available.length > 0) {
    lines.push('Your available Exarchos tools:');
    for (const composite of available) {
      lines.push(`- ${composite.name}: ${composite.actions.join(', ')}`);
    }
  }

  if (denied.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Do NOT call:');
    for (const composite of denied) {
      lines.push(`- ${composite.name}: ${composite.actions.join(', ')}`);
    }
  }

  return lines.join('\n');
}

// ─── Active Workflow Discovery ─────────────────────────────────────────────

/**
 * Scan the state directory for the first non-completed workflow and return its phase.
 * Returns null if no active workflow is found.
 *
 * Uses lightweight JSON parsing (no full Zod validation) since we only need the phase field.
 */
export async function findActiveWorkflowPhase(
  stateDir: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch {
    return null;
  }

  const stateFiles = entries.filter((f) => f.endsWith('.state.json'));

  for (const file of stateFiles) {
    try {
      const raw = await fs.readFile(path.join(stateDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const phase = parsed.phase;

      if (typeof phase === 'string' && phase !== 'completed' && phase !== 'cancelled') {
        return phase;
      }
    } catch {
      // Skip corrupt files
      continue;
    }
  }

  return null;
}

// ─── Historical Intelligence ──────────────────────────────────────────────

/** Event types relevant for historical intelligence. */
const HISTORY_EVENT_TYPES = new Set([
  'workflow.fix-cycle',
  'task.completed',
  'task.failed',
]);

/** Maximum number of JSONL files to scan. */
const MAX_FILES = 10;

/** Maximum number of lines to read from end of each JSONL file. */
const MAX_LINES_PER_FILE = 500;

/** Maximum length of synthesized intelligence string. */
const MAX_INTELLIGENCE_LENGTH = 500;

/**
 * Check if a parsed event's data references any of the specified modules.
 * Searches compoundStateId, artifacts arrays, and taskId fields.
 */
function eventReferencesModules(
  event: Record<string, unknown>,
  modules: string[],
): boolean {
  if (modules.length === 0) return false;

  const data = event.data as Record<string, unknown> | undefined;
  if (!data) return false;

  const searchableFields: string[] = [];

  if (typeof data.compoundStateId === 'string') {
    searchableFields.push(data.compoundStateId);
  }
  if (typeof data.taskId === 'string') {
    searchableFields.push(data.taskId);
  }
  if (Array.isArray(data.artifacts)) {
    for (const artifact of data.artifacts) {
      if (typeof artifact === 'string') {
        searchableFields.push(artifact);
      }
    }
  }

  const combined = searchableFields.join(' ').toLowerCase();
  return modules.some((m) => combined.includes(m.toLowerCase()));
}

/**
 * Expand module names into search terms by splitting on hyphens.
 * For example, 'auth-service' produces ['auth-service', 'auth', 'service'].
 */
function expandModuleSearchTerms(modules: string[]): string[] {
  const terms = new Set<string>();
  for (const m of modules) {
    terms.add(m);
    // Also add individual segments for broader matching
    const parts = m.split('-').filter((p) => p.length > 2);
    for (const part of parts) {
      terms.add(part);
    }
  }
  return Array.from(terms);
}

/**
 * Scan JSONL event files for events relevant to specified modules.
 * Uses lightweight line-by-line JSON parsing (no full EventStore import) for CLI hook performance.
 */
export async function queryModuleHistory(
  stateDir: string,
  modules: string[],
): Promise<Array<Record<string, unknown>>> {
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch {
    return [];
  }

  const jsonlFiles = entries
    .filter((f) => f.endsWith('.events.jsonl'))
    .slice(0, MAX_FILES);

  if (jsonlFiles.length === 0) return [];

  const searchTerms = expandModuleSearchTerms(modules);
  const results: Array<Record<string, unknown>> = [];

  for (const file of jsonlFiles) {
    try {
      const content = await fs.readFile(path.join(stateDir, file), 'utf-8');
      const allLines = content.split('\n').filter((line) => line.trim().length > 0);
      // Take only the last MAX_LINES_PER_FILE lines for performance
      const lines = allLines.slice(-MAX_LINES_PER_FILE);

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const eventType = event.type;

          if (typeof eventType !== 'string' || !HISTORY_EVENT_TYPES.has(eventType)) {
            continue;
          }

          if (eventReferencesModules(event, searchTerms)) {
            results.push(event);
          }
        } catch {
          // Skip unparseable lines
          continue;
        }
      }
    } catch {
      // Skip unreadable files
      continue;
    }
  }

  return results;
}

/**
 * Summarize event patterns into a concise hint string.
 * Capped at 500 chars for hook payload limits.
 */
export function synthesizeIntelligence(
  events: Array<Record<string, unknown>>,
): string {
  if (events.length === 0) return '';

  // Count fix cycles per module
  const fixCyclesPerModule = new Map<string, number>();
  // Count task completions per module
  const taskCompletionsPerModule = new Map<string, number>();
  // Count task failures per module
  const taskFailuresPerModule = new Map<string, number>();

  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined;
    if (!data) continue;

    if (event.type === 'workflow.fix-cycle') {
      const moduleId = typeof data.compoundStateId === 'string'
        ? data.compoundStateId
        : 'unknown';
      fixCyclesPerModule.set(
        moduleId,
        (fixCyclesPerModule.get(moduleId) ?? 0) + 1,
      );
    } else if (event.type === 'task.completed') {
      const moduleId = typeof data.taskId === 'string' ? data.taskId : 'unknown';
      taskCompletionsPerModule.set(
        moduleId,
        (taskCompletionsPerModule.get(moduleId) ?? 0) + 1,
      );
    } else if (event.type === 'task.failed') {
      const moduleId = typeof data.taskId === 'string' ? data.taskId : 'unknown';
      taskFailuresPerModule.set(
        moduleId,
        (taskFailuresPerModule.get(moduleId) ?? 0) + 1,
      );
    }
  }

  const parts: string[] = [];

  if (fixCyclesPerModule.size > 0) {
    const total = Array.from(fixCyclesPerModule.values()).reduce((a, b) => a + b, 0);
    const modules = Array.from(fixCyclesPerModule.keys()).join(', ');
    parts.push(`${total} fix cycle${total === 1 ? '' : 's'} in: ${modules}`);
  }

  if (taskCompletionsPerModule.size > 0) {
    const total = Array.from(taskCompletionsPerModule.values()).reduce((a, b) => a + b, 0);
    parts.push(`${total} task${total === 1 ? '' : 's'} completed`);
  }

  if (taskFailuresPerModule.size > 0) {
    const total = Array.from(taskFailuresPerModule.values()).reduce((a, b) => a + b, 0);
    parts.push(`${total} task${total === 1 ? '' : 's'} failed`);
  }

  const result = parts.join('. ');
  return result.length > MAX_INTELLIGENCE_LENGTH
    ? result.slice(0, MAX_INTELLIGENCE_LENGTH - 3) + '...'
    : result;
}

/**
 * Extract module names from worktree/cwd path.
 * Pulls meaningful path segments that could correspond to module names.
 */
export function extractModulesFromCwd(cwd: string): string[] {
  if (!cwd || cwd === '/') return [];

  // Normalize Windows backslashes before splitting
  const normalized = cwd.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((s) => s.length > 0);

  // Skip generic segments like 'tmp', 'src', 'home', 'var', etc.
  const genericSegments = new Set([
    'tmp', 'src', 'home', 'var', 'usr', 'lib', 'opt',
    'etc', 'bin', 'node_modules', 'dist', 'build',
    '.worktrees', 'plugins', 'servers',
  ]);

  // Look for worktree-style names (wt-*, group-*, feature/*)
  const modules: string[] = [];

  for (const segment of segments) {
    if (genericSegments.has(segment)) continue;
    if (segment.startsWith('.') && segment !== '.worktrees') continue;

    // Worktree naming patterns: wt-<name>, group-<name> — strip prefix for module name
    if (segment.startsWith('wt-')) {
      modules.push(segment.slice(3));
    } else if (segment.startsWith('group-')) {
      modules.push(segment.slice(6));
    }
  }

  // If no worktree-specific segments found, use the last non-generic segment
  if (modules.length === 0) {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (!genericSegments.has(seg) && !seg.startsWith('.')) {
        modules.push(seg);
        break;
      }
    }
  }

  return modules;
}

// ─── Agent Team Detection ─────────────────────────────────────────────────

/**
 * Read native task list from a tasks directory.
 * Each JSON file in the directory represents a task with id, title, and status.
 * Returns empty array if the directory does not exist or is unreadable.
 */
export async function readNativeTaskList(
  tasksDir: string,
): Promise<Array<Record<string, unknown>>> {
  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir);
  } catch {
    return [];
  }

  const jsonFiles = entries.filter((f) => f.endsWith('.json'));
  const results: Array<Record<string, unknown>> = [];

  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(tasksDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      results.push(parsed);
    } catch {
      // Skip unparseable files
      continue;
    }
  }

  return results;
}

/**
 * Detect if the current SubagentStart event originates from a teammate's
 * subprocess (sub-subagent). Detected by cwd being inside a `.worktrees/`
 * directory during the delegate phase.
 *
 * Teammate sub-subagents (tests, formatting, etc.) inherit context from
 * their parent teammate and should not receive additional injection.
 */
export function isTeammateSubSubagent(cwd: string, phase: string): boolean {
  if (phase !== 'delegate') return false;

  const normalized = cwd.replace(/\\/g, '/');
  return normalized.includes('.worktrees/');
}

/**
 * Check if the current workflow is running in agent-team mode.
 * Agent-team mode is detected by the existence of a native team config at:
 *   - `{teamsDir}/{featureId}/config.json` (directory-style)
 *   - `{teamsDir}/{featureId}.json` (flat-file-style)
 */
export async function isAgentTeamMode(
  featureId: string,
  teamsDir: string,
): Promise<boolean> {
  // Check directory-style: {teamsDir}/{featureId}/config.json
  try {
    await fs.access(path.join(teamsDir, featureId, 'config.json'));
    return true;
  } catch {
    // Not found, try flat-file
  }

  // Check flat-file-style: {teamsDir}/{featureId}.json
  try {
    await fs.access(path.join(teamsDir, `${featureId}.json`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Format live task status changes as a human-readable summary.
 * Shows current task statuses from the native task list.
 */
function formatLiveTaskStatus(
  tasks: Array<Record<string, unknown>>,
): string {
  if (tasks.length === 0) return '';

  const lines: string[] = ['Live task statuses:'];

  for (const task of tasks) {
    const id = typeof task.id === 'string' ? task.id : 'unknown';
    const title = typeof task.title === 'string' ? task.title : '';
    const status = typeof task.status === 'string' ? task.status : 'unknown';
    const label = title ? `${id} (${title})` : id;
    lines.push(`- ${label}: ${status}`);
  }

  return lines.join('\n');
}

// ─── Command Handler ───────────────────────────────────────────────────────

/**
 * Resolve the home directory from environment.
 */
function resolveHomeDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error('Cannot determine home directory: HOME and USERPROFILE are both undefined');
  }
  return home;
}

/**
 * Resolve the workflow state directory from environment or default.
 */
function resolveStateDir(): string {
  const envDir = process.env.WORKFLOW_STATE_DIR;
  if (envDir) return envDir;

  return path.join(resolveHomeDir(), '.claude', 'workflow-state');
}

/**
 * Read the active workflow state file and extract the tasks array.
 * Returns the full parsed state or null if no active workflow found.
 */
async function readActiveWorkflowState(
  stateDir: string,
): Promise<Record<string, unknown> | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch {
    return null;
  }

  const stateFiles = entries.filter((f) => f.endsWith('.state.json'));

  for (const file of stateFiles) {
    try {
      const raw = await fs.readFile(path.join(stateDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const phase = parsed.phase;

      if (typeof phase === 'string' && phase !== 'completed' && phase !== 'cancelled') {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Format team context from the active workflow's tasks array.
 * Summarizes task statuses and what other teammates are working on.
 */
async function formatTeamContext(
  stateDir: string,
  activeState?: Record<string, unknown> | null,
): Promise<string> {
  const state = activeState ?? await readActiveWorkflowState(stateDir);
  if (!state) return '';

  const tasks = state.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return '';

  let inProgress = 0;
  let complete = 0;
  let pending = 0;
  const inProgressTitles: string[] = [];

  for (const task of tasks) {
    if (typeof task !== 'object' || task === null) continue;
    const t = task as Record<string, unknown>;
    const status = t.status;

    if (status === 'in_progress') {
      inProgress++;
      if (typeof t.title === 'string') {
        inProgressTitles.push(t.title);
      }
    } else if (status === 'complete' || status === 'completed') {
      complete++;
    } else {
      pending++;
    }
  }

  const parts: string[] = [];

  if (inProgress > 0) {
    parts.push(`${inProgress} task${inProgress === 1 ? '' : 's'} in progress`);
  }
  if (complete > 0) {
    parts.push(`${complete} completed`);
  }
  if (pending > 0) {
    parts.push(`${pending} pending`);
  }

  let result = parts.join(', ');

  if (inProgressTitles.length > 0) {
    result += `. Other teammates working on: ${inProgressTitles.join(', ')}`;
  }

  return result;
}

/**
 * SubagentStart hook handler.
 *
 * Reads the active workflow's phase, filters tools by phase + teammate role,
 * and outputs plain-text guidance to stdout.
 *
 * In agent-team mode (native team config exists):
 *   - Skips historical intelligence (already in spawn prompt)
 *   - Skips static team context (already in spawn prompt)
 *   - Injects live task status changes (data that changed since spawn)
 *   - Retains tool guidance (not in spawn prompt)
 *
 * In subagent mode (no team config):
 *   - Retains all existing behavior (historical intelligence, team context, tool guidance)
 *
 * For teammate sub-subagents during delegate phase:
 *   - Skips all injection (inherits context from parent teammate)
 *
 * Degrades gracefully: outputs empty fields if no active workflow exists.
 */
export async function handleSubagentContext(
  stdinData: Record<string, unknown>,
): Promise<CommandResult> {
  const stateDir = resolveStateDir();

  // One-pass: read active state once and reuse for phase + team context
  const activeState = await readActiveWorkflowState(stateDir);
  const phase = activeState && typeof activeState.phase === 'string'
    && activeState.phase !== 'completed' && activeState.phase !== 'cancelled'
    ? activeState.phase
    : null;

  if (!phase) {
    // Graceful degradation: no active workflow, output empty fields
    return { guidance: '', context: '', team: '' };
  }

  const cwd = typeof stdinData.cwd === 'string' ? stdinData.cwd : '';

  // Determine if we're in agent-team mode
  const homeDir = resolveHomeDir();
  const featureId = typeof activeState?.featureId === 'string'
    ? activeState.featureId
    : '';
  const teamsDir = path.join(homeDir, '.claude', 'teams');
  const teamMode = featureId.length > 0
    ? await isAgentTeamMode(featureId, teamsDir)
    : false;

  // Skip all injection for teammate sub-subagents during delegate
  if (teamMode && isTeammateSubSubagent(cwd, phase)) {
    return { guidance: '', context: '', team: '' };
  }

  // Tool guidance — always present regardless of mode
  const { available, denied } = filterToolsForPhaseAndRole(phase, 'teammate');
  const guidance = formatToolGuidance(available, denied);

  if (teamMode) {
    // Agent-team mode: skip historical intelligence and static team context,
    // inject live task status instead
    const tasksDir = path.join(homeDir, '.claude', 'tasks', featureId);
    const nativeTasks = await readNativeTaskList(tasksDir);
    const liveTaskStatus = formatLiveTaskStatus(nativeTasks);

    return { guidance, context: '', team: '', liveTaskStatus };
  }

  // Subagent mode: retain all existing behavior
  const modules = extractModulesFromCwd(cwd);
  const events = await queryModuleHistory(stateDir, modules);
  const context = synthesizeIntelligence(events);

  // Team context (reuse the already-read state)
  const team = await formatTeamContext(stateDir, activeState);

  return { guidance, context, team };
}
