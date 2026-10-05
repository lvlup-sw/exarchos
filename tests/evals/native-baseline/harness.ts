/**
 * Measures how native Claude Code assigns models to subagents. The harness runs headless
 * `claude -p --output-format stream-json` with a prompt that presents a spec as the plan and
 * asks for Task-tool delegation. Then it reads the model, the tool calls and the token spend of
 * each dispatched subagent from the transcript.
 *
 * The two captured runs in `fixtures/` show two transcript shapes. In one, each subagent streams
 * its `assistant` messages with `parent_tool_use_id`, so `message.model` gives its model. In the
 * other, only `task_started` and `task_notification` events name the subagent. For that shape,
 * {@link resolveSubagentModels} uses the terminal `result.modelUsage` when it holds one model.
 *
 * When the transcript shows no subagent, the record is `blocked` and holds no
 * `modelDistribution`. The distribution comes only from observed subagents. A model that the
 * harness cannot resolve stays `null`.
 *
 * Run live: `tsx tests/evals/native-baseline/harness.ts <specPath> [--model sonnet]`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  stampProvenance,
  assertMeasured,
  type Provenance,
  type ProvenanceStamped,
} from '../../../tools/evals/evals/provenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../../../');

/** A content block inside an assistant message. */
export interface ContentBlock {
  readonly type?: string;
  readonly name?: string;
  readonly id?: string;
  readonly text?: string;
}

/** Per-model aggregate emitted on the terminal `result` event. */
export interface ModelUsageEntry {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly costUSD?: number;
}

/**
 * One parsed stream-json line, with only the fields that matter to this harness. `message` and
 * `parent_tool_use_id` belong to `assistant` and `user` events. The fields from `task_id` to
 * `usage` belong to `task_started` and `task_notification` events. The last three fields belong
 * to the `result` event.
 */
export interface StreamEvent {
  readonly type?: string;
  readonly subtype?: string;
  readonly message?: {
    readonly model?: string;
    readonly content?: readonly ContentBlock[];
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly [k: string]: unknown;
    };
  };
  readonly parent_tool_use_id?: string | null;
  readonly task_id?: string;
  readonly tool_use_id?: string;
  readonly description?: string;
  readonly subagent_type?: string;
  readonly task_type?: string;
  readonly status?: string;
  readonly summary?: string;
  readonly usage?: {
    readonly total_tokens?: number;
    readonly tool_uses?: number;
    readonly duration_ms?: number;
  };
  readonly is_error?: boolean;
  readonly modelUsage?: Readonly<Record<string, ModelUsageEntry>>;
  readonly session_id?: string;
}

/** Result of leniently parsing a stream-json transcript. */
export interface ParsedTranscript {
  readonly events: readonly StreamEvent[];
  /** The count of non-blank lines that are not valid JSON, such as a truncated last line. */
  readonly malformed: number;
}

/**
 * Parses a newline-delimited stream-json transcript. It skips blank lines and counts a line that
 * is not valid JSON, so a truncated last line does not lose the events before it.
 */
export function parseStreamJson(text: string): ParsedTranscript {
  const events: StreamEvent[] = [];
  let malformed = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as StreamEvent);
    } catch {
      malformed += 1;
    }
  }
  return { events, malformed };
}

/** Token spend attributed to one subagent. */
export interface SubagentTokens {
  /** Authoritative total from the subagent's `task_notification.usage.total_tokens` (when present). */
  readonly total: number | null;
  /** Sum of `input_tokens` over the subagent's own assistant messages. */
  readonly input: number;
  /** Sum of `output_tokens` over the subagent's own assistant messages. */
  readonly output: number;
}

/**
 * How the harness found {@link SubagentObservation.model}.
 * - `assistant`: the subagent streamed its `assistant` messages to the parent transcript, and
 *   `message.model` gives the model.
 * - `session-single`: only the `task_notification` of the subagent is in the transcript. The
 *   terminal `result.modelUsage` holds exactly one model, so the subagent ran on it.
 * - `unresolved`: neither signal is available, and the model stays `null`.
 */
export type ModelSource = 'assistant' | 'session-single' | 'unresolved';

/**
 * What native did for one dispatched subagent, as the transcript shows it: the assigned model,
 * the tool calls and the token spend.
 */
export interface SubagentObservation {
  readonly toolUseId: string;
  readonly taskId: string | null;
  readonly subagentType: string | null;
  readonly description: string | null;
  /** The model native assigned this subagent (null if unresolved — see {@link modelSource}). */
  readonly model: string | null;
  /** How the harness found {@link model}. */
  readonly modelSource: ModelSource;
  readonly tokens: SubagentTokens;
  /** Number of tool calls the subagent made (verification/tool behavior). */
  readonly toolUses: number;
  /** Names of the tools the subagent called, in order. */
  readonly toolNames: readonly string[];
  readonly status: string | null;
  readonly finalSummary: string | null;
}

/**
 * Returns one {@link SubagentObservation} for each dispatched subagent, and `[]` when the
 * transcript holds no `task_started` event.
 *
 * - A `system/task_started` event marks a dispatch. Its `tool_use_id` is the key.
 * - An `assistant` event with that `parent_tool_use_id` gives the model, the message tokens and
 *   the tool calls. A null parent is the main agent.
 * - The matching `system/task_notification` gives the total tokens and the status. Its
 *   `tool_uses` count wins when it is larger than the count of `tool_use` blocks, which covers a
 *   subagent that streamed no message.
 */
export function extractSubagents(events: readonly StreamEvent[]): SubagentObservation[] {
  const byToolUseId = new Map<
    string,
    {
      taskId: string | null;
      subagentType: string | null;
      description: string | null;
      model: string | null;
      input: number;
      output: number;
      total: number | null;
      toolUses: number;
      toolNames: string[];
      status: string | null;
      finalSummary: string | null;
    }
  >();

  for (const e of events) {
    if (e.type === 'system' && e.subtype === 'task_started' && typeof e.tool_use_id === 'string') {
      byToolUseId.set(e.tool_use_id, {
        taskId: e.task_id ?? null,
        subagentType: e.subagent_type ?? null,
        description: e.description ?? null,
        model: null,
        input: 0,
        output: 0,
        total: null,
        toolUses: 0,
        toolNames: [],
        status: null,
        finalSummary: null,
      });
    }
  }

  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const parent = e.parent_tool_use_id;
    if (typeof parent !== 'string') continue;
    const rec = byToolUseId.get(parent);
    if (!rec) continue;
    const msg = e.message;
    if (msg?.model && rec.model === null) rec.model = msg.model;
    rec.input += toFiniteNumber(msg?.usage?.input_tokens);
    rec.output += toFiniteNumber(msg?.usage?.output_tokens);
    for (const block of msg?.content ?? []) {
      if (block.type === 'tool_use') {
        rec.toolUses += 1;
        if (typeof block.name === 'string') rec.toolNames.push(block.name);
      }
    }
  }

  for (const e of events) {
    if (e.type !== 'system' || e.subtype !== 'task_notification') continue;
    if (typeof e.tool_use_id !== 'string') continue;
    const rec = byToolUseId.get(e.tool_use_id);
    if (!rec) continue;
    if (e.status) rec.status = e.status;
    if (e.summary) rec.finalSummary = e.summary;
    const total = e.usage?.total_tokens;
    if (typeof total === 'number' && Number.isFinite(total)) rec.total = total;
    const notifTools = e.usage?.tool_uses;
    if (typeof notifTools === 'number' && notifTools > rec.toolUses) rec.toolUses = notifTools;
  }

  return [...byToolUseId.entries()].map(([toolUseId, r]) => ({
    toolUseId,
    taskId: r.taskId,
    subagentType: r.subagentType,
    description: r.description,
    model: r.model,
    modelSource: (r.model !== null ? 'assistant' : 'unresolved') as ModelSource,
    tokens: { total: r.total, input: r.input, output: r.output },
    toolUses: r.toolUses,
    toolNames: r.toolNames,
    status: r.status,
    finalSummary: r.finalSummary,
  }));
}

/**
 * Fills the model of each subagent that has none, for the transcript shape that streams no
 * subagent message. When `result.modelUsage` lists exactly one model, the whole session ran on
 * it, so each such subagent gets it with `modelSource: 'session-single'`. With zero or several
 * session models, the subagent stays `unresolved`. Returns a new array.
 *
 * The `?? null` on the index keeps the type of `model` at `string | null`.
 */
export function resolveSubagentModels(
  subagents: readonly SubagentObservation[],
  sessionModelUsage: Readonly<Record<string, ModelUsageEntry>>,
): SubagentObservation[] {
  const sessionModels = Object.keys(sessionModelUsage);
  const soleModel = sessionModels.length === 1 ? (sessionModels[0] ?? null) : null;
  return subagents.map((s) => {
    if (s.model !== null || soleModel === null) return s;
    return { ...s, model: soleModel, modelSource: 'session-single' as ModelSource };
  });
}

function toFiniteNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Pull the session-wide per-model aggregate from the terminal `result` event. */
export function extractSessionModelUsage(
  events: readonly StreamEvent[],
): Readonly<Record<string, ModelUsageEntry>> {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === 'result' && e.modelUsage) return e.modelUsage;
  }
  return {};
}

/** How the distribution's per-subagent models were attributed overall. */
export type AttributionMode = 'per-subagent' | 'session-single' | 'mixed' | 'none';

export interface ModelDistribution {
  /** Count of dispatched subagents per assigned model id (subagents with a known model). */
  readonly perModel: Readonly<Record<string, number>>;
  /** Number of distinct models assigned across subagents. */
  readonly distinctModelCount: number;
  /**
   * True when every dispatched subagent resolved to one shared model and none is unattributed.
   * Native then inherited a single model and did not route a mix.
   */
  readonly inheritsSingleModel: boolean;
  /** The count of dispatched subagents with no attributed model. */
  readonly unattributed: number;
  /** How the harness attributed the models over all the subagents. */
  readonly attributionMode: AttributionMode;
}

/**
 * Reduces the observations to the model distribution. Run {@link resolveSubagentModels} on the
 * subagents first. A subagent with a `null` model counts under `unattributed`.
 * `inheritsSingleModel` needs one model and zero unattributed subagents, so a partial capture
 * does not claim it.
 */
export function computeModelDistribution(
  subagents: readonly SubagentObservation[],
): ModelDistribution {
  const perModel: Record<string, number> = {};
  let unattributed = 0;
  const sources = new Set<ModelSource>();
  for (const s of subagents) {
    sources.add(s.modelSource);
    if (s.model) perModel[s.model] = (perModel[s.model] ?? 0) + 1;
    else unattributed += 1;
  }
  const distinctModelCount = Object.keys(perModel).length;
  return {
    perModel,
    distinctModelCount,
    inheritsSingleModel: distinctModelCount === 1 && unattributed === 0,
    unattributed,
    attributionMode: attributionModeOf(subagents.length, unattributed, sources),
  };
}

/**
 * Returns `none` when no subagent has a model. Returns `mixed` when some subagents are
 * unresolved, or when both resolved sources occur.
 */
function attributionModeOf(
  total: number,
  unattributed: number,
  sources: ReadonlySet<ModelSource>,
): AttributionMode {
  if (total === 0 || unattributed === total) return 'none';
  if (sources.has('unresolved')) return 'mixed';
  if (sources.has('assistant') && sources.has('session-single')) return 'mixed';
  if (sources.has('session-single')) return 'session-single';
  return 'per-subagent';
}

/** Common fields on every native-baseline record. */
interface NativeBaselineBase {
  /**
   * Both outcomes are `measured`, because a blocked record is a true record of a real run and not
   * a modeled stand-in. `assertMeasured` thus admits both. The guard against an invented
   * distribution is the shape of {@link BlockedNativeBaseline}.
   */
  readonly source: 'measured';
  /** The spec presented to native as its plan (path or short ref). */
  readonly specRef: string;
}

/** Native entered delegation and its per-subagent behavior was measured. */
export interface MeasuredNativeBaseline extends NativeBaselineBase {
  readonly outcome: 'measured';
  readonly subagents: readonly SubagentObservation[];
  readonly modelDistribution: ModelDistribution;
  readonly sessionModelUsage: Readonly<Record<string, ModelUsageEntry>>;
}

/**
 * Native did not delegate. The record holds the reason and the attempted fallbacks. It has no
 * `modelDistribution` field, because the harness observed no subagent. `subagents` is always
 * empty.
 */
export interface BlockedNativeBaseline extends NativeBaselineBase {
  readonly outcome: 'blocked';
  readonly reason: string;
  readonly attempted: readonly string[];
  readonly subagents: readonly [];
}

export type NativeBaselineRecord = MeasuredNativeBaseline | BlockedNativeBaseline;

export interface BuildRecordInput {
  readonly events: readonly StreamEvent[];
  readonly specRef: string;
  /** Fallbacks attempted before concluding blocked (SDK, retries, …) — recorded on a blocked outcome. */
  readonly attempted?: readonly string[];
  /** Optional override reason for a blocked outcome (defaults to the no-delegation reason). */
  readonly blockedReason?: string;
}

/**
 * Builds the record for a parsed transcript. One or more observed subagents give a
 * {@link MeasuredNativeBaseline}, with session-single models filled before the tally. Zero
 * subagents give a {@link BlockedNativeBaseline}.
 *
 * The function derives the distribution from the observed subagents. No argument lets a caller
 * supply one.
 */
export function buildNativeBaselineRecord(input: BuildRecordInput): NativeBaselineRecord {
  const raw = extractSubagents(input.events);
  if (raw.length === 0) {
    return {
      outcome: 'blocked',
      source: 'measured',
      specRef: input.specRef,
      reason:
        input.blockedReason ??
        'native did not enter delegation — no `task_started` subagent dispatch observed in the transcript',
      attempted: input.attempted ?? [],
      subagents: [],
    };
  }
  const sessionModelUsage = extractSessionModelUsage(input.events);
  const subagents = resolveSubagentModels(raw, sessionModelUsage);
  return {
    outcome: 'measured',
    source: 'measured',
    specRef: input.specRef,
    subagents,
    modelDistribution: computeModelDistribution(subagents),
    sessionModelUsage,
  };
}

/**
 * Checks the record with {@link assertMeasured} and stamps it with `provenance`. A measured
 * record and a blocked record both pass. A record with source `modeled` or `assumed` throws.
 */
export function finalizeRecord(
  record: NativeBaselineRecord,
  provenance: Provenance,
): ProvenanceStamped<NativeBaselineRecord> {
  assertMeasured(record);
  return stampProvenance(record, provenance);
}

/**
 * Renders the model distribution as CSV, one row for each pair of subagent type and model. A
 * blocked record gives only a `BLOCKED` marker row, so a reader cannot take it for a measurement.
 */
export function toDistributionCsv(record: NativeBaselineRecord): string {
  const header = 'subagent_type,model,subagents';
  if (record.outcome === 'blocked') {
    return `${header}\nBLOCKED,,0`;
  }
  const rows: string[] = [];
  const counts = new Map<string, number>();
  for (const s of record.subagents) {
    const key = `${s.subagentType ?? 'unknown'} ${s.model ?? 'unknown'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, n] of [...counts.entries()].sort()) {
    const [subagentType, model] = key.split(' ');
    rows.push(`${subagentType},${model},${n}`);
  }
  return [header, ...rows].join('\n');
}

/**
 * Wraps the spec text in a prompt for headless Claude Code. The prompt presents the text as the
 * plan and asks for one subagent for each task. The output is deterministic, so a fixture prompt
 * reproduces exactly.
 */
export function buildDelegationPrompt(specText: string): string {
  return [
    'You are given the following PLAN. Treat it AS your plan — do not re-plan it.',
    '',
    '===== PLAN =====',
    specText.trim(),
    '===== END PLAN =====',
    '',
    'For EACH task in the plan, dispatch a SEPARATE subagent using the Task tool',
    "(subagent_type 'general-purpose'), running them in parallel. Do NOT implement",
    'any task yourself. Each subagent must reason about its task and return a short',
    'answer as its final message. After all subagents finish, report their answers.',
    'Begin the delegation now.',
  ].join('\n');
}

export interface ClaudeArgsOptions {
  readonly prompt: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly dangerouslySkipPermissions?: boolean;
}

/** Build the `claude -p` argv that produces a stream-json transcript. */
export function buildClaudeArgs(opts: ClaudeArgsOptions): string[] {
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose'];
  if (opts.model) args.push('--model', opts.model);
  if (typeof opts.maxTurns === 'number') args.push('--max-turns', String(opts.maxTurns));
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowedTools', opts.allowedTools.join(','));
  }
  if (opts.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  return args;
}

export interface ClaudeRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Runs `claude` with the given argv. The default starts the CLI, and a test injects a fake. */
export type ClaudeRunner = (args: readonly string[]) => Promise<ClaudeRunResult>;

/**
 * The default runner. It starts the real `claude` CLI and captures its output. The 300 second
 * `timeout` kills a hung run, and the error then gives a non-zero `exitCode`.
 */
export const spawnClaude: ClaudeRunner = (args) =>
  new Promise<ClaudeRunResult>((resolve) => {
    execFile(
      'claude',
      [...args],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8', timeout: 300_000 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? Number((err as { code?: number }).code)
            : err
              ? 1
              : 0;
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: code });
      },
    );
  });

export interface RunNativeBaselineOptions {
  /** Spec text presented to native as its plan. */
  readonly specText: string;
  /** A short reference for the record, such as the path of the spec. */
  readonly specRef: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly dangerouslySkipPermissions?: boolean;
  /** The runner. The default is {@link spawnClaude}, and a test injects a canned transcript. */
  readonly runner?: ClaudeRunner;
}

export interface RunNativeBaselineResult {
  readonly record: NativeBaselineRecord;
  readonly transcript: string;
  readonly malformedLines: number;
}

/**
 * Runs `claude -p` and builds the outcome record. The result holds the raw transcript, so the
 * caller can store it.
 *
 * The record is `blocked` when the runner throws or when the transcript shows no subagent. A
 * non-zero exit code then only changes the reason. A non-zero exit with observed subagents still
 * gives a `measured` record.
 */
export async function runNativeBaseline(
  opts: RunNativeBaselineOptions,
): Promise<RunNativeBaselineResult> {
  const runner = opts.runner ?? spawnClaude;
  const prompt = buildDelegationPrompt(opts.specText);
  const args = buildClaudeArgs({
    prompt,
    ...(opts.model ? { model: opts.model } : {}),
    ...(typeof opts.maxTurns === 'number' ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
    ...(opts.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
  });

  let run: ClaudeRunResult;
  try {
    run = await runner(args);
  } catch (err) {
    return {
      record: {
        outcome: 'blocked',
        source: 'measured',
        specRef: opts.specRef,
        reason: `claude failed to launch: ${err instanceof Error ? err.message : String(err)}`,
        attempted: ['claude -p --output-format stream-json'],
        subagents: [],
      },
      transcript: '',
      malformedLines: 0,
    };
  }

  const { events, malformed } = parseStreamJson(run.stdout);

  if (run.exitCode !== 0 && extractSubagents(events).length === 0) {
    return {
      record: {
        outcome: 'blocked',
        source: 'measured',
        specRef: opts.specRef,
        reason: `claude exited ${run.exitCode} with no delegation observed: ${run.stderr.trim().slice(0, 200)}`,
        attempted: ['claude -p --output-format stream-json'],
        subagents: [],
      },
      transcript: run.stdout,
      malformedLines: malformed,
    };
  }

  return {
    record: buildNativeBaselineRecord({
      events,
      specRef: opts.specRef,
      attempted: ['claude -p --output-format stream-json'],
    }),
    transcript: run.stdout,
    malformedLines: malformed,
  };
}

/** The script entry point. `--model` with no value gives the default `sonnet`. */
async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error('usage: tsx harness.ts <specPath> [--model <alias>]');
    process.exit(2);
  }
  const modelIdx = process.argv.indexOf('--model');
  const model = (modelIdx >= 0 ? process.argv[modelIdx + 1] : 'sonnet') ?? 'sonnet';
  const specText = fs.readFileSync(specPath, 'utf-8');

  const { record, transcript, malformedLines } = await runNativeBaseline({
    specText,
    specRef: path.relative(REPO_ROOT, path.resolve(specPath)),
    model,
    allowedTools: ['Task'],
    maxTurns: 8,
    dangerouslySkipPermissions: true,
  });

  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  process.stderr.write(`\n[transcript] ${transcript.length} bytes · ${malformedLines} malformed line(s)\n`);
  process.stderr.write(record.outcome === 'measured' ? '[outcome] MEASURED\n' : '[outcome] BLOCKED\n');
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
