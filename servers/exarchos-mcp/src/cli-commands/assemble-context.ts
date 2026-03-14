import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getOrCreateEventStore, getOrCreateMaterializer } from '../views/tools.js';
import { WORKFLOW_STATUS_VIEW } from '../views/workflow-status-view.js';
import type { WorkflowStatusViewState } from '../views/workflow-status-view.js';
import { TASK_DETAIL_VIEW } from '../views/task-detail-view.js';
import type { TaskDetailViewState } from '../views/task-detail-view.js';
import { HUMAN_CHECKPOINT_PHASES } from '../workflow/next-action.js';
import { getHSMDefinition } from '../workflow/state-machine.js';
import { getPlaybook, renderPlaybook } from '../workflow/playbooks.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

const execFileAsync = promisify(execFileCb);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AssembleContextResult {
  readonly contextDocument: string;
  readonly featureId: string;
  readonly phase: string;
  readonly truncated: boolean;
  readonly [key: string]: unknown;
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

  // Derive from HSM transitions (first non-fix-cycle outbound transition)
  try {
    const hsm = getHSMDefinition(workflowType);
    const transition = hsm.transitions.find(t => t.from === phase && !t.isFixCycle);
    if (transition) {
      return `AUTO:${transition.to}`;
    }
  } catch {
    // Unknown workflow type — fall through
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
  behavioral: string;
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
  // Always include header + behavioral + task table + next action
  const coreParts = [sections.header, sections.behavioral, sections.taskTable, sections.nextAction].filter(
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
  const rawFeatureId = typeof stdinData.featureId === 'string' ? stdinData.featureId.trim() : '';
  const featureId = rawFeatureId && /^[a-z0-9-]+$/.test(rawFeatureId) ? rawFeatureId : '';

  if (!featureId) {
    return { contextDocument: '', featureId: '', phase: '', truncated: false };
  }

  const store = getOrCreateEventStore(stateDir);
  const materializer = getOrCreateMaterializer(stateDir);
  const stateFilePath = path.join(stateDir, `${featureId}.state.json`);

  // 1a. Load snapshots first to learn high-water marks for query optimization
  await Promise.all([
    materializer.loadFromSnapshot(featureId, WORKFLOW_STATUS_VIEW).catch(() => false),
    materializer.loadFromSnapshot(featureId, TASK_DETAIL_VIEW).catch(() => false),
  ]);

  // Compute sinceSequence from snapshot HWMs — skip parsing old events
  const statusHwm = materializer.getState(featureId, WORKFLOW_STATUS_VIEW)?.highWaterMark ?? 0;
  const tasksHwm = materializer.getState(featureId, TASK_DETAIL_VIEW)?.highWaterMark ?? 0;
  const minHwm = Math.min(statusHwm, tasksHwm);
  // Buffer MAX_EVENTS below the HWM so the "Recent Events" section has enough data
  const sinceSequence = Math.max(0, minHwm - MAX_EVENTS);
  const queryFilters = sinceSequence > 0 ? { sinceSequence } : undefined;

  // 1b. Parallel I/O: single event query (with fast-skip), state file read, and git
  const [events, stateFileRaw, gitState] = await Promise.all([
    store.query(featureId, queryFilters).catch((): WorkflowEvent[] => []),
    fs.readFile(stateFilePath, 'utf-8').catch((): null => null),
    queryGitState(stateDir),
  ]);

  // 2. Materialize both CQRS views from the single event query
  let statusView: WorkflowStatusViewState | null = null;
  try {
    statusView = materializer.materialize<WorkflowStatusViewState>(
      featureId, WORKFLOW_STATUS_VIEW, events,
    );
  } catch { /* graceful degradation */ }

  let taskView: TaskDetailViewState | null = null;
  try {
    taskView = materializer.materialize<TaskDetailViewState>(
      featureId, TASK_DETAIL_VIEW, events,
    );
  } catch { /* graceful degradation */ }

  // 3. Parse state file once — authoritative for phase, tasks fallback, and artifacts
  let stateData: Record<string, unknown> | null = null;
  if (stateFileRaw) {
    try {
      stateData = JSON.parse(stateFileRaw) as Record<string, unknown>;
    } catch { /* corrupt state file */ }
  }

  // Check if workflow exists
  if (!stateData && !statusView?.featureId) {
    return { contextDocument: '', featureId, phase: '', truncated: false };
  }

  // State file is authoritative for phase/workflowType (CQRS view might lag)
  const phase = (typeof stateData?.phase === 'string' ? stateData.phase : statusView?.phase) ?? '';
  const workflowType =
    (typeof stateData?.workflowType === 'string' ? stateData.workflowType : statusView?.workflowType) ?? '';

  // 3b. Look up phase playbook for behavioral guidance
  let behavioralSection = '';
  const playbook = getPlaybook(workflowType, phase);
  if (playbook) {
    behavioralSection = renderPlaybook(playbook);
  }

  // 4. Build task rows from CQRS view, fallback to state file
  const taskRows: TaskRow[] = [];
  let totalTaskCount = 0;

  if (taskView) {
    const tasks = Object.values(taskView.tasks);
    totalTaskCount = tasks.length;
    for (const task of tasks) {
      taskRows.push({ taskId: task.taskId, title: task.title, status: task.status });
    }
  }

  if (taskRows.length === 0 && stateData && Array.isArray(stateData.tasks)) {
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

  // 5. Format events section from the already-queried events (no additional I/O)
  let eventsSection = '';
  if (events.length > 0) {
    const recentEvents = events.slice(-MAX_EVENTS);
    const eventLines = recentEvents.map(formatEventSummary);
    eventsSection = ['### Recent Events', ...eventLines].join('\n');
  }

  // 6. Format git section from the already-queried git state (no additional I/O)
  let gitSection = '';
  if (gitState) {
    gitSection = formatGitState(gitState);
  }

  // 7. Format artifacts from state data (already parsed — only artifact file reads are new I/O)
  let artifactsSection = '';
  if (stateData) {
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
  }

  // 8. Compute next action
  const nextAction = computeNextAction(workflowType, phase);
  const nextActionSection = `### Next Action\n${nextAction}`;

  // 9. Build header
  const header = [
    `## Workflow Context: ${featureId}`,
    `**Phase:** ${phase} | **Type:** ${workflowType} | **Started:** ${statusView?.startedAt ?? 'unknown'}`,
  ].join('\n');

  // 10. Format task table
  const taskTable = taskRows.length > 0 ? formatTaskTable(taskRows, totalTaskCount) : '';

  // 11. Assemble and truncate to budget
  const sections: ContextSections = {
    header,
    behavioral: behavioralSection,
    taskTable,
    events: eventsSection,
    gitState: gitSection,
    artifacts: artifactsSection,
    nextAction: nextActionSection,
  };

  const { document, truncated } = truncateToCharBudget(sections);

  return { contextDocument: document, featureId, phase, truncated };
}
