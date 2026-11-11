// Counts the Exarchos calls of each workflow in one recorded Claude Code session.
//
// Usage:
//   npx tsx tools/audit/core/call-shape/observed.ts <session.jsonl>
//
// The counter reads the session file and each `*.jsonl` file under `<session>/subagents/`, at any depth.
// It also descends into a directory that a symbolic link names. It reads each real directory once, so a link loop ends.
//
// It keeps the first event of each `tool_use` id, and it puts each call in exactly one of six counts.
// The call-shape census classifies a call with the same `roleOf`, so the two totals agree on a role.
// The counts of each workflow are split by the caller of the file that holds the call.
// Each file entry also gives the six counts of each workflow over the ids that the file holds first.
//
// The counter exits 2 when a file does not read, or when a tool name maps to no registry tool.
// It also exits 2 when the session holds no Exarchos call.
// It exits 2 when the parsed ids and the ids that a regex finds in the raw text are not the same set.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractToolCalls } from '../../../../src/projections/session/transcript-parser.js';
import type { AgentSpecId } from '../../../../src/runtime/agents/types.js';
import { roleOf, type CallRole } from './census.js';
import type { RegistrySnapshot, RegistryTool } from './extract.js';
import { readRegistry } from './measure.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const REGISTRY_SNAPSHOT = 'tools/audit/registered-actions-snapshot.json';

const USAGE = 'usage: npx tsx tools/audit/core/call-shape/observed.ts <session.jsonl>';

/** The agent that made the calls of one transcript file. */
export type Caller = 'coordinator' | 'reviewer' | 'worker' | 'other' | 'unknown';

/** The number of the first caller rule that matches a file. */
export type CallerRule = 1 | 2 | 3 | 4 | 5;

/** The six counts. Each Exarchos call is in exactly one of them. */
type CountKind = 'work' | 'describe' | 'runbookFetch' | 'failed' | 'noAction' | 'unregistered';

/** The value of each of the six counts. */
export type SixCounts = Readonly<Record<CountKind, number>>;

/** The refusals of the counter. The CLI exits 2 on each one. */
export type ObservedRefusal = 'NO_EXARCHOS_CALL' | 'UNREADABLE_FILE' | 'UNKNOWN_EXARCHOS_TOOL' | 'COUNT_NOT_CONSERVED';

/** The six counts of one workflow and one caller, the sum of the counts and the count of files that hold the calls. */
export interface CountCell extends SixCounts {
  readonly calls: number;
  readonly filesWithCalls: number;
}

/** The counts of one workflow, or of the calls that no workflow takes. */
export interface AttributedCounts {
  /** The sum of the six counts over every caller. The two-call measure reads this sum. */
  readonly total: number;
  readonly counts: SixCounts;
  /** The split by caller. It is a diagnostic, and it selects nothing for the measure. */
  readonly byCaller: Readonly<Record<Caller, CountCell>>;
}

/** The counts of one named workflow. */
export interface WorkflowCounts extends AttributedCounts {
  readonly workflow: string;
}

/** The transcript files of one caller or one rule over the whole tree, with or without an Exarchos call. */
export interface PopulationCell {
  readonly files: number;
  readonly filesWithCalls: number;
  readonly calls: number;
}

/** The six counts of one workflow over the ids that one file holds first. A `null` workflow holds the calls that no workflow takes. */
export interface FileWorkflowCounts {
  readonly workflow: string | null;
  readonly calls: number;
  readonly counts: SixCounts;
}

/** One file of the session tree. A file with no `assistant` or `user` line has no caller and no rule. */
export interface ObservedFile {
  /** The POSIX path of the file, relative to the session. */
  readonly path: string;
  readonly subagent: boolean;
  readonly sha256: string;
  readonly lines: number;
  /** The lines that do not parse as JSON. */
  readonly skippedLines: number;
  readonly transcript: boolean;
  readonly caller: Caller | null;
  readonly rule: CallerRule | null;
  readonly agentType: string | null;
  readonly workflowPhase: string | null;
  /** The calls whose first event this file holds. */
  readonly calls: number;
  readonly counts: SixCounts;
  /** The split of `counts` by workflow, in code-unit order of the workflow, with the calls that no workflow takes last. */
  readonly byWorkflow: readonly FileWorkflowCounts[];
}

/** A count that is in a workflow sum but that no rule expects, or a count of calls that no workflow takes. */
export interface ObservedFinding {
  readonly workflow: string | null;
  readonly caller: Caller | null;
  readonly calls: number;
  readonly reason: string;
}

/** The output of the counter for one session tree. */
export interface ObservedCallCount {
  readonly sessionId: string;
  readonly attribution: string;
  readonly files: readonly ObservedFile[];
  readonly noTranscript: readonly string[];
  readonly workflows: readonly WorkflowCounts[];
  readonly unattributed: AttributedCounts;
  readonly population: {
    readonly byCaller: Readonly<Record<Caller, PopulationCell>>;
    readonly byRule: Readonly<Record<CallerRule, PopulationCell>>;
  };
  /** Each file that rule 3 makes a coordinator file, with the free label of its Workflow phase. */
  readonly ruleThreeFiles: readonly { readonly path: string; readonly workflowPhase: string | null }[];
  readonly ruleThreeByPhase: readonly { readonly workflowPhase: string | null; readonly files: number }[];
  readonly findings: readonly ObservedFinding[];
  /** The events whose `tool_use` id an earlier event holds. */
  readonly repeatedEvents: number;
  /** The distinct Exarchos `tool_use` ids that the regex finds in the raw text of the files. */
  readonly distinctIds: number;
}

/** A refusal of the counter, with its code. */
export class ObservedCallCountError extends Error {
  readonly code: ObservedRefusal;

  constructor(code: ObservedRefusal, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ObservedCallCountError';
    this.code = code;
  }
}

const ATTRIBUTION =
  'A call takes the first string among its input fields featureId, streamId, stream and workflowId. ' +
  'Else it takes the latest workflow that an earlier call of its own file names. ' +
  'Else it takes the latest workflow that the session file names before its timestamp. Else it is unattributed.';

const COUNT_KINDS: readonly CountKind[] = ['work', 'describe', 'runbookFetch', 'failed', 'noAction', 'unregistered'];

/** The caller of each agent spec. A new agent spec with no entry fails the typecheck. */
const AGENT_SPEC_CALLER: Record<AgentSpecId, 'worker' | 'reviewer'> = {
  implementer: 'worker',
  fixer: 'worker',
  scaffolder: 'worker',
  reviewer: 'reviewer',
};

/** An agent type of an Exarchos agent spec, with or without the plugin prefix. */
const AGENT_SPEC_TYPE = /^(?:exarchos:)?exarchos-(.+)$/;

/** One Exarchos `tool_use` block, with the id and the name of the block read together. */
const TOOL_USE_PATTERN = /"type":"tool_use","id":"(toolu_[A-Za-z0-9_]+)","name":"mcp__[^"]*__exarchos_[a-z_]+"/g;

/** The callers whose calls are a finding, with the reason of each. */
const FINDING_REASONS: readonly { readonly caller: Caller; readonly reason: string }[] = [
  { caller: 'worker', reason: 'The design says that workers never call MCP.' },
  { caller: 'other', reason: 'No rule names what an other file does.' },
  { caller: 'unknown', reason: 'No rule names what an unknown file does.' },
];

const UNATTRIBUTED_REASON = 'A call that no workflow takes is in no workflow sum.';

/** The fields of the meta file beside a subagent file. */
interface SubagentMeta {
  readonly hasMeta: boolean;
  readonly agentType: string | null;
  readonly workflowPhase: string | null;
}

/** One Exarchos call event of a file, in the order of the file. */
interface CallEvent {
  readonly id: string;
  readonly tool: RegistryTool;
  readonly action: string | undefined;
  readonly named: string | undefined;
  readonly failed: boolean;
  readonly ts: string;
}

/** One file that the counter read and parsed. */
interface ParsedFile {
  readonly path: string;
  readonly subagent: boolean;
  readonly text: string;
  readonly sha256: string;
  readonly lines: number;
  readonly skippedLines: number;
  readonly transcript: boolean;
  readonly meta: SubagentMeta;
  readonly events: readonly CallEvent[];
}

/** A call whose first event a file holds, with its count, its workflow and the index of its file. */
interface CountedCall {
  readonly fileIndex: number;
  readonly kind: CountKind;
  readonly workflow: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const inner = value[key];
  return typeof inner === 'string' ? inner : null;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code: unknown = error.code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The code-unit order, with `null` after each string. */
function byCodeUnitNullLast(a: string | null, b: string | null): number {
  if (a === null || b === null) {
    if (a === b) return 0;
    return a === null ? 1 : -1;
  }
  return byCodeUnit(a, b);
}

function emptyCounts(): Record<CountKind, number> {
  return { work: 0, describe: 0, runbookFetch: 0, failed: 0, noAction: 0, unregistered: 0 };
}

function sumOf(counts: SixCounts): number {
  return COUNT_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
}

/** True when a symbolic link names a directory. A link that does not resolve names no directory. */
function linksToDirectory(absolute: string): boolean {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Lists each `*.jsonl` entry under `dir` as a POSIX path that starts with `prefix`.
 * It reads no entry type for a `.jsonl` name, so an entry that does not read refuses later.
 * It descends into each other directory, and into a directory that a symbolic link names.
 * `visited` holds the real path of each directory that the walk listed, so the walk lists each real directory once.
 * Each path keeps the entry names of the listing, not the real path. A missing directory holds no entry.
 */
function listTranscriptEntries(dir: string, prefix: string, visited: Set<string>): string[] {
  let entries: Dirent[];
  try {
    const real = realpathSync(dir);
    if (visited.has(real)) return [];
    visited.add(real);
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw new ObservedCallCountError('UNREADABLE_FILE', `${prefix} does not list: ${messageOf(error)}`);
  }
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => byCodeUnit(a.name, b.name))) {
    const rel = `${prefix}/${entry.name}`;
    const absolute = path.join(dir, entry.name);
    if (entry.name.endsWith('.jsonl')) found.push(rel);
    else if (entry.isDirectory() || (entry.isSymbolicLink() && linksToDirectory(absolute))) {
      found.push(...listTranscriptEntries(absolute, rel, visited));
    }
  }
  return found;
}

/** Reads the meta file beside a subagent file. A meta file that does not read or parse gives no agent type. */
function readMeta(absoluteJsonl: string): SubagentMeta {
  const metaPath = `${absoluteJsonl.slice(0, -'.jsonl'.length)}.meta.json`;
  let text: string;
  try {
    text = readFileSync(metaPath, 'utf8');
  } catch {
    return { hasMeta: false, agentType: null, workflowPhase: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { hasMeta: true, agentType: null, workflowPhase: null };
  }
  return { hasMeta: true, agentType: stringField(parsed, 'agentType'), workflowPhase: stringField(parsed, 'workflowPhase') };
}

/** Maps a raw tool name to the registry tool named by the text after its last `__`. */
function registryToolOf(registry: RegistrySnapshot, name: string, file: string): RegistryTool {
  const at = name.lastIndexOf('__');
  const toolName = at === -1 ? name : name.slice(at + 2);
  const tool = registry.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    throw new ObservedCallCountError('UNKNOWN_EXARCHOS_TOOL', `${file}: ${name} maps to no registry tool`);
  }
  return tool;
}

/** Reads one file of the tree. It counts each nonblank line that does not parse, and it keeps the Exarchos call events. */
function parseFile(
  absolute: string,
  rel: string,
  subagent: boolean,
  sessionId: string,
  registry: RegistrySnapshot,
): ParsedFile {
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    throw new ObservedCallCountError('UNREADABLE_FILE', `${rel} does not read: ${messageOf(error)}`);
  }
  const text = bytes.toString('utf8');
  const parsedLines: unknown[] = [];
  let lines = 0;
  let skippedLines = 0;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    lines += 1;
    try {
      const value: unknown = JSON.parse(trimmed);
      parsedLines.push(value);
    } catch {
      skippedLines += 1;
    }
  }
  const transcript = parsedLines.some((line) => isRecord(line) && (line.type === 'assistant' || line.type === 'user'));
  const events: CallEvent[] = [];
  for (const event of extractToolCalls(parsedLines, { sessionId })) {
    if (event.cat !== 'mcp_exarchos' || event.toolUseId === undefined) continue;
    events.push({
      id: event.toolUseId,
      tool: registryToolOf(registry, event.tool, rel),
      action: event.action,
      named: event.featureId,
      failed: event.failed === true,
      ts: event.ts,
    });
  }
  return {
    path: rel,
    subagent,
    text,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    lines,
    skippedLines,
    transcript,
    meta: subagent ? readMeta(absolute) : { hasMeta: false, agentType: null, workflowPhase: null },
    events,
  };
}

/** The caller and the rule of a transcript file. The first rule that matches decides. */
function callerOf(file: ParsedFile): { readonly caller: Caller; readonly rule: CallerRule } | null {
  if (!file.subagent) return { caller: 'coordinator', rule: 1 };
  if (!file.transcript) return null;
  const spec = AGENT_SPEC_TYPE.exec(file.meta.agentType ?? '')?.[1];
  if (spec !== undefined && isAgentSpecId(spec)) return { caller: AGENT_SPEC_CALLER[spec], rule: 2 };
  const governs = file.events.some(
    (event) => event.tool.name === 'exarchos_orchestrate' && (event.action === 'prepare' || event.action === 'settle'),
  );
  if (governs) return { caller: 'coordinator', rule: 3 };
  if (!file.meta.hasMeta || file.meta.agentType === null) return { caller: 'unknown', rule: 4 };
  return { caller: 'other', rule: 5 };
}

function isAgentSpecId(value: string): value is AgentSpecId {
  return Object.hasOwn(AGENT_SPEC_CALLER, value);
}

/** The count of a call. The first rule that matches decides: no action, then unregistered, then failed, then the role. */
function countKindOf(event: CallEvent): CountKind {
  if (event.action === undefined) return 'noAction';
  if (!event.tool.actions.includes(event.action)) return 'unregistered';
  if (event.failed) return 'failed';
  return kindOfRole(roleOf(`${event.tool.name}.${event.action}`));
}

function kindOfRole(role: CallRole): CountKind {
  switch (role) {
    case 'work':
      return 'work';
    case 'describe':
      return 'describe';
    case 'runbook-fetch':
      return 'runbookFetch';
    case 'native':
      throw new Error('an Exarchos call has no native role');
  }
}

/** The workflows that the session file names, each with the time of its call. */
function sessionNamings(session: ParsedFile): { readonly at: number; readonly workflow: string }[] {
  const namings: { readonly at: number; readonly workflow: string }[] = [];
  for (const event of session.events) {
    const at = Date.parse(event.ts);
    if (event.named !== undefined && !Number.isNaN(at)) namings.push({ at, workflow: event.named });
  }
  return namings;
}

/** The latest workflow that the session file names before `ts`, or `undefined` when it names none. */
function latestSessionWorkflow(namings: readonly { readonly at: number; readonly workflow: string }[], ts: string): string | undefined {
  const callAt = Date.parse(ts);
  if (Number.isNaN(callAt)) return undefined;
  let best: { readonly at: number; readonly workflow: string } | undefined;
  for (const naming of namings) {
    if (naming.at < callAt && (best === undefined || naming.at >= best.at)) best = naming;
  }
  return best?.workflow;
}

function emptyAttributed(): {
  counts: Record<CountKind, number>;
  byCaller: Record<Caller, { counts: Record<CountKind, number>; files: Set<number> }>;
} {
  const byCaller = {
    coordinator: { counts: emptyCounts(), files: new Set<number>() },
    reviewer: { counts: emptyCounts(), files: new Set<number>() },
    worker: { counts: emptyCounts(), files: new Set<number>() },
    other: { counts: emptyCounts(), files: new Set<number>() },
    unknown: { counts: emptyCounts(), files: new Set<number>() },
  };
  return { counts: emptyCounts(), byCaller };
}

function freezeAttributed(raw: ReturnType<typeof emptyAttributed>): AttributedCounts {
  const cell = (caller: Caller): CountCell => {
    const { counts, files } = raw.byCaller[caller];
    return { ...counts, calls: sumOf(counts), filesWithCalls: files.size };
  };
  return {
    total: sumOf(raw.counts),
    counts: { ...raw.counts },
    byCaller: {
      coordinator: cell('coordinator'),
      reviewer: cell('reviewer'),
      worker: cell('worker'),
      other: cell('other'),
      unknown: cell('unknown'),
    },
  };
}

function emptyPopulation(): { files: number; filesWithCalls: number; calls: number } {
  return { files: 0, filesWithCalls: 0, calls: 0 };
}

/** The split of one file by workflow, in code-unit order of the workflow, with the calls that no workflow takes last. */
function fileSplitOf(split: ReadonlyMap<string | null, Record<CountKind, number>>): FileWorkflowCounts[] {
  return [...split.entries()]
    .sort(([a], [b]) => byCodeUnitNullLast(a, b))
    .map(([workflow, counts]) => ({ workflow, calls: sumOf(counts), counts: { ...counts } }));
}

/**
 * Counts the Exarchos calls of each workflow in the session tree of `sessionFile`.
 * It throws `ObservedCallCountError` with the code of each refusal.
 */
export function countObservedCalls(sessionFile: string): ObservedCallCount {
  const registry = readRegistry(readFileSync(path.join(REPO_ROOT, REGISTRY_SNAPSHOT), 'utf8'));
  const sessionName = path.basename(sessionFile);
  const sessionId = sessionName.endsWith('.jsonl') ? sessionName.slice(0, -'.jsonl'.length) : sessionName;
  const sessionDir = path.join(path.dirname(sessionFile), sessionId);

  const subagentPaths = listTranscriptEntries(path.join(sessionDir, 'subagents'), 'subagents', new Set<string>()).sort(byCodeUnit);
  const files: ParsedFile[] = [
    parseFile(sessionFile, sessionName, false, sessionId, registry),
    ...subagentPaths.map((rel) => parseFile(path.join(sessionDir, ...rel.split('/')), rel, true, sessionId, registry)),
  ];
  const session = files[0];
  if (session === undefined) throw new Error('the session file is missing from the read list');
  const callers = files.map(callerOf);
  const namings = sessionNamings(session);

  const seen = new Set<string>();
  let repeatedEvents = 0;
  const counted: CountedCall[] = [];
  files.forEach((file, fileIndex) => {
    let latestInFile: string | undefined;
    for (const event of file.events) {
      const workflow = event.named ?? latestInFile ?? latestSessionWorkflow(namings, event.ts) ?? null;
      if (event.named !== undefined) latestInFile = event.named;
      if (seen.has(event.id)) {
        repeatedEvents += 1;
        continue;
      }
      seen.add(event.id);
      counted.push({ fileIndex, kind: countKindOf(event), workflow });
    }
  });

  const byWorkflow = new Map<string, ReturnType<typeof emptyAttributed>>();
  const unattributedRaw = emptyAttributed();
  const fileCounts = files.map(() => emptyCounts());
  const fileSplits = files.map(() => new Map<string | null, Record<CountKind, number>>());
  for (const call of counted) {
    const assigned = callers[call.fileIndex];
    const fileCount = fileCounts[call.fileIndex];
    const fileSplit = fileSplits[call.fileIndex];
    if (assigned === null || assigned === undefined || fileCount === undefined || fileSplit === undefined) {
      throw new Error(`a call sits in ${files[call.fileIndex]?.path ?? 'a file'}, which has no caller`);
    }
    let target = unattributedRaw;
    if (call.workflow !== null) {
      const existing = byWorkflow.get(call.workflow);
      target = existing ?? emptyAttributed();
      if (existing === undefined) byWorkflow.set(call.workflow, target);
    }
    target.counts[call.kind] += 1;
    target.byCaller[assigned.caller].counts[call.kind] += 1;
    target.byCaller[assigned.caller].files.add(call.fileIndex);
    fileCount[call.kind] += 1;
    const workflowCount = fileSplit.get(call.workflow) ?? emptyCounts();
    workflowCount[call.kind] += 1;
    fileSplit.set(call.workflow, workflowCount);
  }

  const workflows: WorkflowCounts[] = [...byWorkflow.keys()]
    .sort(byCodeUnit)
    .map((workflow) => {
      const raw = byWorkflow.get(workflow);
      if (raw === undefined) throw new Error(`the workflow ${workflow} has no counts`);
      return { workflow, ...freezeAttributed(raw) };
    });
  const unattributed = freezeAttributed(unattributedRaw);

  const regexIds = new Set<string>();
  for (const file of files) {
    for (const match of file.text.matchAll(TOOL_USE_PATTERN)) {
      const id = match[1];
      if (id !== undefined) regexIds.add(id);
    }
  }
  const sum = workflows.reduce((total, workflow) => total + workflow.total, unattributed.total);
  const unparsed = [...regexIds].filter((id) => !seen.has(id));
  const unmatched = [...seen].filter((id) => !regexIds.has(id));
  if (sum !== regexIds.size || unparsed.length > 0 || unmatched.length > 0) {
    throw new ObservedCallCountError(
      'COUNT_NOT_CONSERVED',
      `the six counts sum to ${sum}, and the regex finds ${regexIds.size} distinct ids. ` +
        `Ids in the text that no parsed call holds: ${unparsed.join(', ') || 'none'}. ` +
        `Parsed ids that the regex does not find: ${unmatched.join(', ') || 'none'}.`,
    );
  }
  if (sum === 0) {
    throw new ObservedCallCountError('NO_EXARCHOS_CALL', `${sessionName} and its subagent files hold no Exarchos call`);
  }

  const observedFiles: ObservedFile[] = files.map((file, fileIndex) => {
    const assigned = callers[fileIndex] ?? null;
    const counts = fileCounts[fileIndex] ?? emptyCounts();
    const split = fileSplits[fileIndex] ?? new Map<string | null, Record<CountKind, number>>();
    return {
      path: file.path,
      subagent: file.subagent,
      sha256: file.sha256,
      lines: file.lines,
      skippedLines: file.skippedLines,
      transcript: file.transcript,
      caller: assigned?.caller ?? null,
      rule: assigned?.rule ?? null,
      agentType: file.meta.agentType,
      workflowPhase: file.meta.workflowPhase,
      calls: sumOf(counts),
      counts: { ...counts },
      byWorkflow: fileSplitOf(split),
    };
  });

  const populationByCaller = {
    coordinator: emptyPopulation(),
    reviewer: emptyPopulation(),
    worker: emptyPopulation(),
    other: emptyPopulation(),
    unknown: emptyPopulation(),
  };
  const populationByRule = { 1: emptyPopulation(), 2: emptyPopulation(), 3: emptyPopulation(), 4: emptyPopulation(), 5: emptyPopulation() };
  for (const file of observedFiles) {
    if (file.caller === null || file.rule === null) continue;
    for (const cell of [populationByCaller[file.caller], populationByRule[file.rule]]) {
      cell.files += 1;
      cell.calls += file.calls;
      if (file.calls > 0) cell.filesWithCalls += 1;
    }
  }

  const ruleThreeFiles = observedFiles
    .filter((file) => file.rule === 3)
    .map((file) => ({ path: file.path, workflowPhase: file.workflowPhase }));
  const phaseCounts = new Map<string | null, number>();
  for (const file of ruleThreeFiles) phaseCounts.set(file.workflowPhase, (phaseCounts.get(file.workflowPhase) ?? 0) + 1);
  const ruleThreeByPhase = [...phaseCounts.entries()]
    .map(([workflowPhase, count]) => ({ workflowPhase, files: count }))
    .sort((a, b) => byCodeUnitNullLast(a.workflowPhase, b.workflowPhase));

  const findings: ObservedFinding[] = [];
  for (const workflow of workflows) {
    for (const { caller, reason } of FINDING_REASONS) {
      const calls = workflow.byCaller[caller].calls;
      if (calls > 0) findings.push({ workflow: workflow.workflow, caller, calls, reason });
    }
  }
  if (unattributed.total > 0) {
    findings.push({ workflow: null, caller: null, calls: unattributed.total, reason: UNATTRIBUTED_REASON });
  }

  return {
    sessionId,
    attribution: ATTRIBUTION,
    files: observedFiles,
    noTranscript: observedFiles.filter((file) => file.subagent && !file.transcript).map((file) => file.path),
    workflows,
    unattributed,
    population: {
      byCaller: populationByCaller,
      byRule: populationByRule,
    },
    ruleThreeFiles,
    ruleThreeByPhase,
    findings,
    repeatedEvents,
    distinctIds: regexIds.size,
  };
}

function main(args: readonly string[]): number {
  const [session] = args;
  if (session === undefined) {
    console.error(USAGE);
    return 2;
  }
  try {
    console.log(JSON.stringify(countObservedCalls(path.resolve(session)), null, 2));
    return 0;
  } catch (error) {
    if (error instanceof ObservedCallCountError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedAs)).href) {
  process.exitCode = main(process.argv.slice(2));
}
