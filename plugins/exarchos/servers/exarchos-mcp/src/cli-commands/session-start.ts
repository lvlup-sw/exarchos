import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CommandResult } from '../cli.js';
import { listStateFiles } from '../workflow/state-store.js';

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

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * Annotate workflows with native team cleanup recommendations.
 * Mutates the workflow objects in place by adding nativeTeamCleanup field
 * for workflows that are past the delegation phase but still have a native team.
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
 * Handle the `session-start` CLI command.
 *
 * Priority:
 * 1. If checkpoint files exist, return their resume context (and delete them).
 * 2. If no checkpoints, scan for active (non-terminal) workflow state files.
 * 3. If nothing found, return silently (no error, no workflows).
 *
 * Additionally, when teamsDir is provided, checks for orphaned native Agent
 * Teams directories and includes cleanup recommendations.
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

    if (teamsDir) return applyNativeTeamDetection(workflows, teamsDir);
    return { workflows };
  }

  // Step 2: No checkpoints — discover active workflows from state files
  try {
    const stateFiles = await listStateFiles(stateDir);
    const activeWorkflows = stateFiles.filter(
      (entry) => !TERMINAL_PHASES.has(entry.state.phase),
    );

    if (activeWorkflows.length === 0 && !teamsDir) return {};

    const workflows: WorkflowInfo[] = activeWorkflows.map((entry) => ({
      featureId: entry.featureId,
      phase: entry.state.phase,
      summary: `Active workflow discovered (${entry.state.workflowType})`,
      nextAction: `WAIT:in-progress:${entry.state.phase}`,
    }));

    if (teamsDir) return applyNativeTeamDetection(workflows, teamsDir);
    if (workflows.length === 0) return {};
    return { workflows };
  } catch {
    // If state dir doesn't exist or is unreadable, still check for orphaned teams
    if (teamsDir) return applyNativeTeamDetection([], teamsDir);
    return {};
  }
}
