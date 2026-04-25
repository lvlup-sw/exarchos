// ─── T058 — `assemble-context` migrated to the shared rehydrate path (DR-16).
//
// This adapter is now a thin markdown formatter over the canonical
// `exarchos_workflow.rehydrate` output: it calls `handleRehydrate` to fold
// the rehydration@v1 projection (snapshot + event tail) into a
// `RehydrationDocument`, then renders that document to the markdown shape
// legacy callers (`pre-compact`, `session-start`, etc.) have depended on
// since `assemble-context` first shipped.
//
// Why this shape: the plan (T058, DR-16) mandates a single projection
// surface so snapshot cadence, degraded-mode handling, and schema drift are
// solved once per reducer rather than per call site. The reducer does not
// yet capture every legacy markdown affordance (task titles, playbook
// render, per-event HH:MM summaries, git-state sidecar), so we supplement
// those from the state file and the event store alongside the canonical
// envelope. The supplementary reads are for *presentation only*; the
// authoritative projection source is always the returned document.
//
// Inline rehydration walk, CQRS-view materialization, and snapshot-HWM
// optimization were removed in the REFACTOR commit following this GREEN.
// Anything still here is either (a) needed to format the legacy markdown,
// or (b) a supplementary read the reducer does not yet cover.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventStore } from '../event-store/store.js';
import { HUMAN_CHECKPOINT_PHASES } from '../workflow/human-checkpoint-phases.js';
import { getHSMDefinition } from '../workflow/state-machine.js';
import { getPlaybook, renderPlaybook } from '../workflow/playbooks.js';
import { handleRehydrate } from '../workflow/rehydrate.js';
import type { RehydrationDocument } from '../projections/rehydration/schema.js';
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

/**
 * Merge the reducer's `taskProgress` entries (authoritative status via the
 * task.* event fold) with task titles from the state file. The reducer's
 * entries only carry `{id, status}`; the state file has free-form `title`
 * strings that predate this reducer and would otherwise be lost. When the
 * reducer has no folded tasks, fall back to the state-file tasks alone
 * (matches the pre-T058 shape for workflows that have not emitted any
 * task.* events yet).
 */
function mergeTaskRows(
  docTaskProgress: ReadonlyArray<{ readonly id: string; readonly status: string }> | undefined,
  stateTasks: ReadonlyArray<Record<string, unknown>>,
): TaskRow[] {
  const stateTaskById = new Map<string, Record<string, unknown>>();
  for (const t of stateTasks) {
    const id = String(t.id ?? t.taskId ?? '');
    if (id.length > 0) stateTaskById.set(id, t);
  }

  if (docTaskProgress && docTaskProgress.length > 0) {
    return docTaskProgress.map((entry) => {
      const stateTask = stateTaskById.get(entry.id);
      const title =
        stateTask && typeof stateTask.title === 'string' ? stateTask.title : entry.id;
      return { taskId: entry.id, title, status: entry.status };
    });
  }

  return stateTasks.map((t) => ({
    taskId: String(t.id ?? t.taskId ?? ''),
    title: String(t.title ?? ''),
    status: String(t.status ?? ''),
  }));
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

/**
 * Assemble the legacy markdown context document for a workflow by
 * dispatching through `exarchos_workflow.rehydrate` (DR-16). The rehydration
 * reducer is now the single authoritative source for workflowState,
 * taskProgress, artifacts, and blockers; this handler supplements with the
 * state file (for task titles + artifact first-line summaries), the event
 * store (for the HH:MM event list), git (for the Git State sidecar), and
 * the phase playbook (for the Behavioral Guidance section), then formats
 * the result as the markdown shape pre-compact/session-start expect.
 */
export async function handleAssembleContext(
  stdinData: Record<string, unknown>,
  stateDir: string,
): Promise<AssembleContextResult> {
  const rawFeatureId = typeof stdinData.featureId === 'string' ? stdinData.featureId.trim() : '';
  const featureId = rawFeatureId && /^[a-z0-9-]+$/.test(rawFeatureId) ? rawFeatureId : '';

  if (!featureId) {
    return { contextDocument: '', featureId: '', phase: '', truncated: false };
  }

  const eventStore = new EventStore(stateDir);
  const stateFilePath = path.join(stateDir, `${featureId}.state.json`);

  // Dispatch to the canonical rehydrate handler for the document. Errors
  // surface as `success: false`; treat them like an empty projection so
  // the adapter degrades rather than throws (session-start/pre-compact
  // rely on it never raising).
  const rehydrateResult = await handleRehydrate(
    { featureId },
    { stateDir, eventStore },
  );

  // Parallel reads for presentation layers the reducer does not yet
  // capture: git sidecar, state file (for artifact first-lines + task
  // titles), and the raw event stream (for the HH:MM summaries).
  const [stateFileRaw, gitState, recentEvents] = await Promise.all([
    fs.readFile(stateFilePath, 'utf-8').catch((): null => null),
    queryGitState(stateDir),
    eventStore.query(featureId).catch((): WorkflowEvent[] => []),
  ]);

  // Canonical document from the reducer. If the reducer failed outright
  // we still check for the state file — the prior inline handler returned
  // an empty document for "no workflow" and we preserve that contract.
  const doc: RehydrationDocument | undefined =
    rehydrateResult.success && rehydrateResult.data
      ? (rehydrateResult.data as RehydrationDocument)
      : undefined;

  let stateData: Record<string, unknown> | null = null;
  if (stateFileRaw) {
    try {
      stateData = JSON.parse(stateFileRaw) as Record<string, unknown>;
    } catch { /* corrupt state file */ }
  }

  // Empty-stream + no state file → no workflow. Mirrors the historical
  // "unknown feature" contract that session-start and pre-compact rely on.
  const reducerHasFeature =
    doc !== undefined &&
    (doc.workflowState.featureId.length > 0 ||
      doc.workflowState.phase.length > 0 ||
      doc.taskProgress.length > 0);
  if (!stateData && !reducerHasFeature) {
    return { contextDocument: '', featureId, phase: '', truncated: false };
  }

  // Phase + workflowType: state file is authoritative (it's the CQRS write
  // side; the reducer trails by the number of events still tailing). Fall
  // back to the reducer's workflowState when the state file is absent.
  const phase =
    (typeof stateData?.phase === 'string' ? stateData.phase : doc?.workflowState.phase) ?? '';
  const workflowType =
    (typeof stateData?.workflowType === 'string'
      ? stateData.workflowType
      : doc?.workflowState.workflowType) ?? '';

  // Behavioral guidance — render the phase playbook. The reducer's
  // `behavioralGuidance` currently carries empty strings (T022's minimal
  // initial doc; a later task may populate it), so the live render from
  // the playbooks registry is the authoritative presentation source here.
  let behavioralSection = '';
  const playbook = getPlaybook(workflowType, phase);
  if (playbook) {
    behavioralSection = renderPlaybook(playbook);
  }

  // Task table — reducer's taskProgress (authoritative status) merged with
  // state-file task titles. Helper keeps the main function flat.
  const stateTasks: Array<Record<string, unknown>> =
    stateData && Array.isArray(stateData.tasks)
      ? (stateData.tasks as Array<Record<string, unknown>>)
      : [];
  const taskRows = mergeTaskRows(doc?.taskProgress, stateTasks);
  const totalTaskCount = taskRows.length;

  // Events section — formatted from the event stream query (the reducer
  // does not preserve the ordered event list; it folds into projection
  // state). Kept as-is so the HH:MM sidecar stays unchanged post-migration.
  let eventsSection = '';
  if (recentEvents.length > 0) {
    const tail = recentEvents.slice(-MAX_EVENTS);
    const eventLines = tail.map(formatEventSummary);
    eventsSection = ['### Recent Events', ...eventLines].join('\n');
  }

  // Git section.
  let gitSection = '';
  if (gitState) {
    gitSection = formatGitState(gitState);
  }

  // Artifacts — prefer the state file (carries the full object shape,
  // including `null` slots for pr/etc.) for first-line summary reads.
  // The reducer's artifacts map is a flat `Record<string, string>`, so
  // when the state file is absent we fall back to it.
  let artifactsSection = '';
  const artifactsFromState =
    stateData && typeof stateData.artifacts === 'object' && stateData.artifacts !== null
      ? (stateData.artifacts as Record<string, string | null>)
      : undefined;
  const artifactsFromDoc = doc?.artifacts;
  const artifactDesign =
    artifactsFromState?.design ?? artifactsFromDoc?.design ?? null;
  const artifactPlan =
    artifactsFromState?.plan ?? artifactsFromDoc?.plan ?? null;
  if (artifactDesign || artifactPlan) {
    const refs = await Promise.all([
      formatArtifactRef('Design', artifactDesign),
      formatArtifactRef('Plan', artifactPlan),
    ]);
    const validRefs = refs.filter((r) => r.length > 0);
    if (validRefs.length > 0) {
      artifactsSection = ['### Artifacts', ...validRefs].join('\n');
    }
  }

  // Next action.
  const nextAction = computeNextAction(workflowType, phase);
  const nextActionSection = `### Next Action\n${nextAction}`;

  // Header — startedAt is not on the canonical document (it's a property
  // of the `workflow.started` event timestamp, not the folded projection
  // state). We preserve the legacy "unknown" sentinel rather than
  // reviving a second event-store walk just to surface it.
  const header = [
    `## Workflow Context: ${featureId}`,
    `**Phase:** ${phase} | **Type:** ${workflowType} | **Started:** unknown`,
  ].join('\n');

  const taskTable = taskRows.length > 0 ? formatTaskTable(taskRows, totalTaskCount) : '';

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
