import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CommandResult } from '../cli.js';
import { listStateFiles } from '../workflow/state-store.js';
import { telemetryProjection } from '../telemetry/telemetry-projection.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { generateHints } from '../telemetry/hints.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Shape of a checkpoint file written by the pre-compact command. */
interface CheckpointData {
  readonly featureId: string;
  readonly timestamp: string;
  readonly phase: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly tasks: ReadonlyArray<{ id: string; status: string; title: string }>;
  readonly artifacts: Record<string, unknown>;
  readonly stateFile: string;
  readonly teamState?: unknown;
  readonly contextFile?: string;
}

/** Recovery info attached when orphaned team state is detected. */
interface RecoveryInfo {
  readonly type: string;
  readonly message: string;
  readonly completedTasks: number;
  readonly remainingTasks: number;
}

/** Info about a detected native Agent Teams directory. */
export interface NativeTeamInfo {
  readonly memberNames: ReadonlyArray<string>;
  readonly memberCount: number;
}

/** A discovered workflow for the session-start response. */
interface WorkflowInfo {
  readonly featureId: string;
  readonly phase: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly tasks?: ReadonlyArray<{ id: string; status: string; title: string }>;
  readonly recovery?: RecoveryInfo;
  readonly nativeTeamCleanup?: string;
}

/** Result from the session-start command. */
export interface SessionStartResult extends CommandResult {
  readonly workflows?: ReadonlyArray<WorkflowInfo>;
  readonly orphanedTeams?: ReadonlyArray<string>;
  readonly telemetryHints?: ReadonlyArray<string>;
  readonly contextDocument?: string;
}

// ─── Terminal Phases ────────────────────────────────────────────────────────

const TERMINAL_PHASES = new Set(['completed', 'cancelled']);
const DELEGATE_PHASES = new Set(['delegate', 'overhaul-delegate']);

// ─── Type Guard ──────────────────────────────────────────────────────────────

/** Validate that parsed JSON matches the CheckpointData shape before use. */
function isCheckpointData(value: unknown): value is CheckpointData {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.featureId === 'string' &&
    typeof obj.timestamp === 'string' &&
    typeof obj.phase === 'string' &&
    typeof obj.summary === 'string' &&
    typeof obj.nextAction === 'string' &&
    Array.isArray(obj.tasks) &&
    typeof obj.stateFile === 'string'
  );
}

// ─── Checkpoint Reader ──────────────────────────────────────────────────────

/**
 * Scan the state directory for checkpoint files and return their data.
 * Each checkpoint is deleted after being read.
 */
async function readAndDeleteCheckpoints(stateDir: string): Promise<CheckpointData[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR') {
      return [];
    }
    throw err;
  }

  const checkpointFiles = entries.filter((f) => f.endsWith('.checkpoint.json'));
  const results: CheckpointData[] = [];

  for (const file of checkpointFiles) {
    const filePath = path.join(stateDir, file);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!isCheckpointData(parsed)) {
        // Skip invalid checkpoint — don't delete, don't crash
        continue;
      }
      // Delete BEFORE adding to results to ensure at-most-once delivery.
      // If unlink fails, the file stays on disk and is NOT added to results,
      // preventing duplicate processing on the next session start.
      await fs.unlink(filePath);
      results.push(parsed);
    } catch {
      // Skip malformed or undeletable checkpoint files — do not crash
      continue;
    }
  }

  return results;
}

// ─── Context File Reader ────────────────────────────────────────────────────

/**
 * Read and delete a pre-computed context.md file.
 * Returns the file content on success, or null if the file is missing or unreadable.
 * Deletes the file before returning to ensure at-most-once delivery.
 */
async function readAndDeleteContextFile(contextPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(contextPath, 'utf-8');
    await fs.unlink(contextPath);
    return content;
  } catch {
    return null;
  }
}

/**
 * Collect and combine context documents from checkpoints that have a contextFile field.
 * Multiple context documents are joined with a `\n---\n` separator.
 * Validates that contextFile paths are contained within stateDir to prevent path traversal.
 * Returns undefined when no context documents are available.
 */
async function collectContextDocuments(
  checkpoints: ReadonlyArray<CheckpointData>,
  stateDir: string,
): Promise<string | undefined> {
  const contextDocuments: string[] = [];
  const resolvedStateDir = path.resolve(stateDir);

  for (const cp of checkpoints) {
    if (!cp.contextFile) continue;
    const resolvedPath = path.resolve(stateDir, cp.contextFile);
    if (!resolvedPath.startsWith(resolvedStateDir + path.sep) && resolvedPath !== resolvedStateDir) continue;
    const content = await readAndDeleteContextFile(resolvedPath);
    if (content) {
      contextDocuments.push(content);
    }
  }

  return contextDocuments.length > 0
    ? contextDocuments.join('\n---\n')
    : undefined;
}

// ─── Orphaned Team Detection ────────────────────────────────────────────────

/**
 * Detect orphaned team state from a checkpoint.
 * Returns recovery info if the checkpoint is in the delegate phase and has
 * active (non-completed) teammates. Returns undefined otherwise.
 */
function detectOrphanedTeam(
  checkpoint: CheckpointData,
): RecoveryInfo | undefined {
  if (!DELEGATE_PHASES.has(checkpoint.phase)) return undefined;
  if (!checkpoint.teamState || typeof checkpoint.teamState !== 'object') return undefined;

  const ts = checkpoint.teamState as Record<string, unknown>;
  const teammates = ts.teammates;
  if (!Array.isArray(teammates) || teammates.length === 0) return undefined;

  const activeTeammates = teammates.filter((t) => {
    if (!t || typeof t !== 'object') return false;
    const teammate = t as Record<string, unknown>;
    return teammate.status === 'active';
  });

  if (activeTeammates.length === 0) return undefined;

  const completedTasks = checkpoint.tasks.filter((t) => t.status === 'complete').length;
  const remainingTasks = checkpoint.tasks.length - completedTasks;

  return {
    type: 'orphaned_team',
    message: `${activeTeammates.length} active teammate(s) orphaned after compaction`,
    completedTasks,
    remainingTasks,
  };
}

// ─── Native Team Directory Detection ────────────────────────────────────────

/**
 * Try to parse a team config from raw JSON content.
 * Returns a NativeTeamInfo if the config has a non-empty members array,
 * or null if the content is malformed or has no members.
 */
function parseTeamConfig(raw: string): NativeTeamInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.members) || obj.members.length === 0) return null;

  const memberNames: string[] = [];
  for (const member of obj.members) {
    if (!member || typeof member !== 'object') continue;
    const m = member as Record<string, unknown>;
    if (typeof m.name === 'string') {
      memberNames.push(m.name);
    }
  }

  if (memberNames.length === 0) return null;

  return {
    memberNames,
    memberCount: memberNames.length,
  };
}

/**
 * Detect a native Agent Teams directory for a given featureId.
 *
 * Checks two formats:
 * 1. Directory format: `{teamsDir}/{featureId}/config.json`
 * 2. Flat file format: `{teamsDir}/{featureId}.json`
 *
 * Directory format takes precedence. Returns NativeTeamInfo with member
 * names and count, or null if no valid team config is found.
 */
export async function detectNativeTeam(
  featureId: string,
  teamsDir: string,
): Promise<NativeTeamInfo | null> {
  // Try directory format first: {teamsDir}/{featureId}/config.json
  const dirConfigPath = path.join(teamsDir, featureId, 'config.json');
  try {
    const raw = await fs.readFile(dirConfigPath, 'utf-8');
    const info = parseTeamConfig(raw);
    if (info) return info;
  } catch {
    // File doesn't exist or is unreadable — fall through to flat file format
  }

  // Try flat file format: {teamsDir}/{featureId}.json
  const flatFilePath = path.join(teamsDir, `${featureId}.json`);
  try {
    const raw = await fs.readFile(flatFilePath, 'utf-8');
    return parseTeamConfig(raw);
  } catch {
    // File doesn't exist or is unreadable
    return null;
  }
}

/**
 * List all feature IDs that have native team directories or files.
 * Scans the teamsDir for both directory-format and flat-file-format teams.
 */
async function listNativeTeamFeatureIds(teamsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(teamsDir);
  } catch {
    return [];
  }

  const featureIds = new Set<string>();

  for (const entry of entries) {
    // Flat file: {featureId}.json
    if (entry.endsWith('.json')) {
      featureIds.add(entry.replace(/\.json$/, ''));
      continue;
    }

    // Directory: {featureId}/config.json — check if it's a directory
    const entryPath = path.join(teamsDir, entry);
    try {
      const stat = await fs.stat(entryPath);
      if (stat.isDirectory()) {
        featureIds.add(entry);
      }
    } catch {
      // Skip unreadable entries
    }
  }

  return [...featureIds];
}

// ─── Telemetry Hint Injection ────────────────────────────────────────────────

/**
 * Query telemetry event stream and generate optimization hints.
 *
 * Reads the telemetry JSONL file, materializes the telemetry projection
 * using init() + apply() directly (no ViewMaterializer dependency),
 * and returns formatted hint strings.
 *
 * Gracefully handles missing files by returning an empty array.
 */
export async function queryTelemetryHints(stateDir: string): Promise<string[]> {
  const telemetryPath = path.join(stateDir, 'telemetry.events.jsonl');

  let raw: string;
  try {
    raw = await fs.readFile(telemetryPath, 'utf-8');
  } catch {
    return [];
  }

  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  let state = telemetryProjection.init();

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as WorkflowEvent;
      state = telemetryProjection.apply(state, event);
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  const hints = generateHints(state);
  if (hints.length === 0) return [];

  return hints.map((h) => `${h.tool}: ${h.hint}`);
}

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * Annotate workflows with native team cleanup recommendations.
 * Replaces array elements with new WorkflowInfo objects containing the
 * nativeTeamCleanup field for workflows past the delegation phase
 * that still have a native team directory.
 */
async function annotateNativeTeamCleanup(
  workflows: WorkflowInfo[],
  teamsDir: string,
): Promise<void> {
  for (let i = 0; i < workflows.length; i++) {
    const workflow = workflows[i];
    const teamInfo = await detectNativeTeam(workflow.featureId, teamsDir);
    if (!teamInfo) continue;

    // If the workflow is in a delegation phase, the team is expected — no warning
    if (DELEGATE_PHASES.has(workflow.phase)) continue;

    // Workflow is past delegation but team still exists — recommend cleanup
    workflows[i] = {
      ...workflow,
      nativeTeamCleanup: `Orphaned native team detected for ${workflow.featureId} (${teamInfo.memberCount} member(s): ${teamInfo.memberNames.join(', ')}). Run TeamDelete to clean up.`,
    };
  }
}

/**
 * Detect native team directories that have no corresponding workflow.
 * Returns cleanup recommendation strings for each orphaned team.
 */
async function detectOrphanedTeamsWithoutWorkflows(
  workflowFeatureIds: Set<string>,
  teamsDir: string,
): Promise<string[]> {
  const allTeamIds = await listNativeTeamFeatureIds(teamsDir);
  const orphaned: string[] = [];

  for (const teamId of allTeamIds) {
    if (workflowFeatureIds.has(teamId)) continue;

    const teamInfo = await detectNativeTeam(teamId, teamsDir);
    if (!teamInfo) continue;

    orphaned.push(
      `Orphaned native team detected for ${teamId} (${teamInfo.memberCount} member(s): ${teamInfo.memberNames.join(', ')}). No active workflow found. Run TeamDelete to clean up.`,
    );
  }

  return orphaned;
}

/**
 * Apply native team detection to a set of workflows and return the final result.
 * Handles both per-workflow cleanup annotations and orphaned team detection.
 */
async function applyNativeTeamDetection(
  workflows: WorkflowInfo[],
  teamsDir: string,
): Promise<SessionStartResult> {
  await annotateNativeTeamCleanup(workflows, teamsDir);

  const allWorkflowIds = new Set(workflows.map((w) => w.featureId));
  const orphanedTeams = await detectOrphanedTeamsWithoutWorkflows(allWorkflowIds, teamsDir);

  if (workflows.length === 0 && orphanedTeams.length === 0) return {};
  if (workflows.length === 0) return { orphanedTeams };
  if (orphanedTeams.length > 0) return { workflows, orphanedTeams };
  return { workflows };
}

/**
 * Enrich a session-start result with telemetry optimization hints.
 * Only adds the `telemetryHints` field when hints are non-empty.
 */
async function enrichWithTelemetryHints(
  result: SessionStartResult,
  stateDir: string,
): Promise<SessionStartResult> {
  const hints = await queryTelemetryHints(stateDir);
  if (hints.length === 0) return result;
  return { ...result, telemetryHints: hints };
}

/**
 * Handle the `session-start` CLI command.
 *
 * Priority:
 * 1. If checkpoint files exist, return their resume context (and delete them).
 * 2. If no checkpoints, scan for active (non-terminal) workflow state files.
 * 3. If nothing found, return silently (no error, no workflows).
 *
 * Additionally, when teamsDir is provided, checks for orphaned native Agent
 * Teams directories and includes cleanup recommendations.
 *
 * Telemetry hints are appended when the telemetry stream contains metrics
 * that exceed optimization thresholds.
 */
export async function handleSessionStart(
  _stdinData: Record<string, unknown>,
  stateDir: string,
  teamsDir?: string,
): Promise<SessionStartResult> {
  // Step 1: Check for checkpoint files (highest priority)
  const checkpoints = await readAndDeleteCheckpoints(stateDir);

  if (checkpoints.length > 0) {
    // Collect featureIds from checkpoints to exclude from state file discovery
    const checkpointFeatureIds = new Set(checkpoints.map((cp) => cp.featureId));

    const workflows: WorkflowInfo[] = checkpoints.map((cp) => {
      const recovery = detectOrphanedTeam(cp);
      return {
        featureId: cp.featureId,
        phase: cp.phase,
        summary: cp.summary,
        nextAction: cp.nextAction,
        tasks: cp.tasks.length > 0 ? cp.tasks : undefined,
        ...(recovery !== undefined && { recovery }),
      };
    });

    // Collect pre-computed context documents from checkpoint references
    const contextDocument = await collectContextDocuments(checkpoints, stateDir);

    // Also check for active state files not covered by checkpoints
    try {
      const stateFiles = await listStateFiles(stateDir);
      for (const entry of stateFiles) {
        if (checkpointFeatureIds.has(entry.featureId)) continue;
        if (TERMINAL_PHASES.has(entry.state.phase)) continue;

        workflows.push({
          featureId: entry.featureId,
          phase: entry.state.phase,
          summary: `Active workflow discovered (${entry.state.workflowType})`,
          nextAction: `WAIT:in-progress:${entry.state.phase}`,
        });
      }
    } catch {
      // Non-critical: if listing fails, we still have checkpoint data
    }

    const baseResult: SessionStartResult = contextDocument
      ? { workflows, contextDocument }
      : { workflows };

    if (teamsDir) {
      const teamResult = await applyNativeTeamDetection(workflows, teamsDir);
      const merged = contextDocument ? { ...teamResult, contextDocument } : teamResult;
      return enrichWithTelemetryHints(merged, stateDir);
    }
    return enrichWithTelemetryHints(baseResult, stateDir);
  }

  // Step 2: No checkpoints — discover active workflows from state files
  try {
    const stateFiles = await listStateFiles(stateDir);
    const activeWorkflows = stateFiles.filter(
      (entry) => !TERMINAL_PHASES.has(entry.state.phase),
    );

    if (activeWorkflows.length === 0 && !teamsDir) return enrichWithTelemetryHints({}, stateDir);

    const workflows: WorkflowInfo[] = activeWorkflows.map((entry) => ({
      featureId: entry.featureId,
      phase: entry.state.phase,
      summary: `Active workflow discovered (${entry.state.workflowType})`,
      nextAction: `WAIT:in-progress:${entry.state.phase}`,
    }));

    if (teamsDir) return enrichWithTelemetryHints(await applyNativeTeamDetection(workflows, teamsDir), stateDir);
    if (workflows.length === 0) return enrichWithTelemetryHints({}, stateDir);
    return enrichWithTelemetryHints({ workflows }, stateDir);
  } catch {
    // If state dir doesn't exist or is unreadable, still check for orphaned teams
    if (teamsDir) return enrichWithTelemetryHints(await applyNativeTeamDetection([], teamsDir), stateDir);
    return enrichWithTelemetryHints({}, stateDir);
  }
}
