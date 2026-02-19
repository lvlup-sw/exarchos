import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { handleViewWorkflowStatus, handleViewTasks } from '../views/tools.js';
import { EventStore } from '../event-store/store.js';
import { PHASE_ACTION_MAP, HUMAN_CHECKPOINT_PHASES } from '../workflow/next-action.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

const execFileAsync = promisify(execFileCb);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AssembleContextResult {
  readonly contextDocument: string;
  readonly featureId: string;
  readonly phase: string;
  readonly truncated: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CHAR_BUDGET = 8000;
const MAX_TASK_ROWS = 10;
const MAX_EVENTS = 5;
const GIT_TIMEOUT_MS = 5000;

// ─── Next Action Computation ────────────────────────────────────────────────

function computeNextAction(workflowType: string, phase: string): string {
  const humanCheckpoints = HUMAN_CHECKPOINT_PHASES[workflowType];
  if (humanCheckpoints?.has(phase)) {
    return `WAIT:human-checkpoint:${phase}`;
  }

  const actionMap = PHASE_ACTION_MAP[workflowType];
  const action = actionMap?.[phase];
  if (action) {
    return action;
  }

  return `WAIT:in-progress:${phase}`;
}

// ─── Formatting Helpers ─────────────────────────────────────────────────────

interface TaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
}

function formatTaskTable(tasks: TaskRow[], totalCount: number): string {
  const displayed = tasks.slice(0, MAX_TASK_ROWS);
  const lines: string[] = [
    '### Task Progress',
    '| ID | Title | Status |',
    '|----|-------|--------|',
  ];

  for (const task of displayed) {
    lines.push(`| ${task.taskId} | ${task.title} | ${task.status} |`);
  }

  const overflow = totalCount - displayed.length;
  if (overflow > 0) {
    lines.push(`+${overflow} more tasks not shown`);
  }

  return lines.join('\n');
}

function formatEventSummary(event: WorkflowEvent): string {
  const ts = new Date(event.timestamp);
  const hh = String(ts.getUTCHours()).padStart(2, '0');
  const mm = String(ts.getUTCMinutes()).padStart(2, '0');

  const detail = deriveEventDetail(event);
  return `- ${hh}:${mm} ${event.type} ${detail}`;
}

function deriveEventDetail(event: WorkflowEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data) return '';

  const parts: string[] = [];

  if (typeof data.featureId === 'string') {
    parts.push(data.featureId);
  }
  if (typeof data.from === 'string' && typeof data.to === 'string') {
    parts.push(`${data.from} -> ${data.to}`);
  }
  if (typeof data.taskId === 'string') {
    parts.push(data.taskId);
  }
  if (typeof data.title === 'string') {
    parts.push(data.title);
  }
  if (typeof data.workflowType === 'string' && !parts.includes(data.workflowType)) {
    parts.push(data.workflowType);
  }

  return parts.join(' ');
}

interface GitState {
  readonly branch: string;
  readonly recentCommits: string;
  readonly workingTree: string;
}

function formatGitState(git: GitState): string {
  const lines: string[] = ['### Git State'];
  lines.push(`**Branch:** ${git.branch}`);

  if (git.recentCommits.trim()) {
    lines.push('**Recent commits:**');
    for (const line of git.recentCommits.trim().split('\n')) {
      lines.push(`- ${line}`);
    }
  }

  const porcelain = git.workingTree.trim();
  if (porcelain.length === 0) {
    lines.push('**Working tree:** clean');
  } else {
    const modified = porcelain.split('\n').length;
    lines.push(`**Working tree:** ${modified} modified`);
  }

  return lines.join('\n');
}

async function formatArtifactRef(
  label: string,
  artifactPath: string | null | undefined,
): Promise<string> {
  if (!artifactPath || typeof artifactPath !== 'string') {
    return '';
  }

  try {
    const content = await fs.readFile(artifactPath, 'utf-8');
    const firstLine = content.split('\n')[0] ?? artifactPath;
    return `- ${label}: ${firstLine}`;
  } catch {
    return `- ${label}: ${artifactPath}`;
  }
}

// ─── Truncation ─────────────────────────────────────────────────────────────

interface ContextSections {
  header: string;
  taskTable: string;
  events: string;
  gitState: string;
  artifacts: string;
  nextAction: string;
}

function truncateToCharBudget(sections: ContextSections): {
  document: string;
  truncated: boolean;
} {
  // Always include header + task table + next action
  const coreParts = [sections.header, sections.taskTable, sections.nextAction].filter(
    (s) => s.length > 0,
  );

  // Try including all optional sections
  const optionalSections = [
    { key: 'events', content: sections.events },
    { key: 'gitState', content: sections.gitState },
    { key: 'artifacts', content: sections.artifacts },
  ].filter((s) => s.content.length > 0);

  const allParts = [...coreParts, ...optionalSections.map((s) => s.content)];
  const fullDoc = allParts.join('\n\n');

  if (fullDoc.length <= CHAR_BUDGET) {
    return { document: fullDoc, truncated: false };
  }

  // Drop sections in order: events -> git -> artifacts
  const dropOrder = ['events', 'gitState', 'artifacts'];
  let remaining = [...optionalSections];

  for (const key of dropOrder) {
    remaining = remaining.filter((s) => s.key !== key);
    const parts = [...coreParts, ...remaining.map((s) => s.content)];
    const doc = parts.join('\n\n');
    if (doc.length <= CHAR_BUDGET) {
      return { document: doc, truncated: true };
    }
  }

  // Even core sections exceed budget — return what we have
  const coreDoc = coreParts.join('\n\n');
  return { document: coreDoc.slice(0, CHAR_BUDGET), truncated: true };
}

// ─── Async Git Queries ──────────────────────────────────────────────────────

async function queryGitState(cwd?: string): Promise<GitState | null> {
  try {
    const opts = { timeout: GIT_TIMEOUT_MS, ...(cwd ? { cwd } : {}) };
    const [branchResult, logResult, statusResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts),
      execFileAsync('git', ['log', '--oneline', '-3'], opts),
      execFileAsync('git', ['status', '--porcelain'], opts),
    ]);

    return {
      branch: branchResult.stdout.trim(),
      recentCommits: logResult.stdout.trim(),
      workingTree: statusResult.stdout.trim(),
    };
  } catch {
    return null;
  }
}

// ─── Main Handler ───────────────────────────────────────────────────────────

export async function handleAssembleContext(
  stdinData: Record<string, unknown>,
  stateDir: string,
): Promise<AssembleContextResult> {
  const featureId = typeof stdinData.featureId === 'string' ? stdinData.featureId : '';

  if (!featureId) {
    return {
      contextDocument: '',
      featureId: '',
      phase: '',
      truncated: false,
    };
  }

  // 1. Query CQRS views for workflow status and tasks
  const [statusResult, tasksResult] = await Promise.all([
    handleViewWorkflowStatus({ workflowId: featureId }, stateDir),
    handleViewTasks({ workflowId: featureId }, stateDir),
  ]);

  // If workflow status fails or has no data, return empty
  if (!statusResult.success || !statusResult.data) {
    return {
      contextDocument: '',
      featureId,
      phase: '',
      truncated: false,
    };
  }

  const status = statusResult.data as {
    featureId: string;
    workflowType: string;
    phase: string;
    startedAt: string;
    tasksTotal: number;
    tasksCompleted: number;
    tasksFailed: number;
  };

  // Check if the workflow actually exists by verifying both the state file
  // and that the CQRS view materialized meaningful data
  const hasStateFile = await fs.access(path.join(stateDir, `${featureId}.state.json`))
    .then(() => true)
    .catch(() => false);

  if (!hasStateFile && !status.featureId) {
    return {
      contextDocument: '',
      featureId,
      phase: '',
      truncated: false,
    };
  }

  // Use state file phase as authoritative (CQRS view might lag)
  let phase = status.phase;
  let workflowType = status.workflowType;

  // Read state file directly for authoritative phase
  try {
    const stateFilePath = path.join(stateDir, `${featureId}.state.json`);
    const raw = await fs.readFile(stateFilePath, 'utf-8');
    const stateData = JSON.parse(raw) as Record<string, unknown>;
    if (typeof stateData.phase === 'string') {
      phase = stateData.phase;
    }
    if (typeof stateData.workflowType === 'string') {
      workflowType = stateData.workflowType;
    }
  } catch {
    // Fall back to CQRS view data
  }

  // 2. Build task rows from CQRS view
  const taskRows: TaskRow[] = [];
  let totalTaskCount = 0;

  if (tasksResult.success && Array.isArray(tasksResult.data)) {
    const tasks = tasksResult.data as Array<{
      taskId: string;
      title: string;
      status: string;
    }>;
    totalTaskCount = tasks.length;
    for (const task of tasks) {
      taskRows.push({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
      });
    }
  }

  // Also check state file tasks if CQRS returned nothing
  if (taskRows.length === 0) {
    try {
      const stateFilePath = path.join(stateDir, `${featureId}.state.json`);
      const raw = await fs.readFile(stateFilePath, 'utf-8');
      const stateData = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(stateData.tasks)) {
        for (const t of stateData.tasks) {
          const task = t as Record<string, unknown>;
          taskRows.push({
            taskId: String(task.id ?? task.taskId ?? ''),
            title: String(task.title ?? ''),
            status: String(task.status ?? ''),
          });
        }
        totalTaskCount = taskRows.length;
      }
    } catch {
      // No tasks available
    }
  }

  // 3. Query recent events via EventStore
  let eventsSection = '';
  try {
    const store = new EventStore(stateDir);
    const events = await store.query(featureId, { limit: MAX_EVENTS });
    if (events.length > 0) {
      // Take the last MAX_EVENTS events (most recent)
      const recentEvents = events.slice(-MAX_EVENTS);
      const eventLines = recentEvents.map(formatEventSummary);
      eventsSection = ['### Recent Events', ...eventLines].join('\n');
    }
  } catch {
    // Graceful degradation — skip events section
  }

  // 4. Query git state asynchronously (run in stateDir context)
  let gitSection = '';
  try {
    const gitState = await queryGitState(stateDir);
    if (gitState) {
      gitSection = formatGitState(gitState);
    }
  } catch {
    // Skip git section on failure
  }

  // 5. Read artifact first lines
  let artifactsSection = '';
  try {
    const stateFilePath = path.join(stateDir, `${featureId}.state.json`);
    const raw = await fs.readFile(stateFilePath, 'utf-8');
    const stateData = JSON.parse(raw) as Record<string, unknown>;
    const artifacts = stateData.artifacts as Record<string, string | null> | undefined;

    if (artifacts) {
      const refs = await Promise.all([
        formatArtifactRef('Design', artifacts.design),
        formatArtifactRef('Plan', artifacts.plan),
      ]);
      const validRefs = refs.filter((r) => r.length > 0);
      if (validRefs.length > 0) {
        artifactsSection = ['### Artifacts', ...validRefs].join('\n');
      }
    }
  } catch {
    // Skip artifacts section
  }

  // 6. Compute next action
  const nextAction = computeNextAction(workflowType, phase);
  const nextActionSection = `### Next Action\n${nextAction}`;

  // 7. Build header
  const header = [
    `## Workflow Context: ${featureId}`,
    `**Phase:** ${phase} | **Type:** ${workflowType} | **Started:** ${status.startedAt}`,
  ].join('\n');

  // 8. Format task table
  const taskTable = taskRows.length > 0 ? formatTaskTable(taskRows, totalTaskCount) : '';

  // 9. Assemble and truncate to budget
  const sections: ContextSections = {
    header,
    taskTable,
    events: eventsSection,
    gitState: gitSection,
    artifacts: artifactsSection,
    nextAction: nextActionSection,
  };

  const { document, truncated } = truncateToCharBudget(sections);

  return {
    contextDocument: document,
    featureId,
    phase,
    truncated,
  };
}
