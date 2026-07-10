// ─── Exp 2 · Native-baseline spike harness (#1670 · DR-3 / DR-7) ──────────────
//
// PURPOSE (spike-first). The prior #1636 benchmark ASSUMED native Claude Code
// routes a flat `opus` model to every subagent (`NATIVE_FLAT_MODEL='opus'`). That
// assumption was never measured. This harness MEASURES native's actual behavior:
// it drives REAL headless Claude Code (`claude -p --output-format stream-json`)
// with a prompt that presents a shared spec AS the plan and instructs Task-tool
// delegation, then parses the session transcript for, PER dispatched subagent:
//   • the `model` native assigned it,
//   • its verification/tool behavior (tool_use count + names), and
//   • its token spend.
// The measured per-subagent model distribution is emitted as raw data (stamped
// through the Task-001 provenance module) — the artifact that retires the
// assumption.
//
// ── PROVEN MECHANIC (what the spike found) ───────────────────────────────────
// Two real `claude -p ... --model sonnet` runs on 2026-07-09, each dispatching 3
// general-purpose subagents over a 3-task plan, captured as fixtures. Delegation
// entered reproducibly in BOTH: every subagent surfaces as a `system/task_started`
// event (keyed by `tool_use_id`) plus a `system/task_notification` carrying its
// token total + status. But the two runs differed in ONE way that matters, and
// that difference is itself a finding:
//   • Variant A (`fixtures/delegation-sonnet-3subagents.jsonl`): the subagents
//     ALSO streamed their own `assistant` messages to the parent transcript, with
//     `parent_tool_use_id === tool_use_id` — so each subagent's model was read
//     DIRECTLY off `message.model`. All three = `claude-sonnet-5`.
//   • Variant B (`fixtures/delegation-sonnet-notification-only.jsonl`): the
//     subagents' `assistant` messages were NOT streamed to the parent transcript
//     (every `assistant` event had `parent_tool_use_id: null` — main agent only).
//     Per-MESSAGE model attribution is therefore UNRELIABLE across runs.
//   → The robust, always-present signal is the terminal `result.modelUsage`: in
//     both runs it held exactly ONE key (`claude-sonnet-5`). With N subagents
//     dispatched and a single-model session, every subagent PROVABLY ran on that
//     one model. So {@link resolveSubagentModels} back-fills the model for the
//     notification-only variant from the sole session model (marked
//     `modelSource: 'session-single'` for honesty — a measured inference, not a
//     guess), and per-message linkage refines it when Variant A applies.
//   → FINDING: native CC subagents INHERIT the session model; they are NOT
//     assigned distinct per-subagent models by default. Native routes a FLAT
//     model (whatever `--model` selected), not a mix. This re-grounds the
//     "model selection vs native" claim on observed data — and corrects the
//     `NATIVE_FLAT_MODEL='opus'` assumption: native IS flat, but on the SESSION
//     model, not a fixed opus.
//
// ── FAIL-HONEST (DR-7) ───────────────────────────────────────────────────────
// If native does NOT enter delegation (zero subagents observed), the harness
// emits a BLOCKED record — an honest measured NEGATIVE — that carries the reason
// and the fallbacks attempted, and DELIBERATELY has NO `modelDistribution`. There
// is no code path that fabricates a distribution: the distribution is only ever
// derived from subagents actually observed in a real transcript. A modeled or
// assumed substitute is never admitted (that was the #1669 sin this feature
// exists to undo). When a subagent's model cannot be resolved even from the
// session (a multi-model session with no per-message linkage), it stays `null` /
// `unresolved` and is counted under `unattributed` — never guessed.
//
// ── SDK FALLBACK ─────────────────────────────────────────────────────────────
// `claude -p` transcript capture proved RELIABLE for DELEGATION detection, token
// spend, and (via `result.modelUsage`) model attribution — so the primary
// `claude -p` mechanic is used. The one fragile surface is per-MESSAGE subagent
// model linkage (Variant B above), which the session-single resolution already
// covers for the flat-model case. The Claude Agent SDK is the reserve path if
// richer per-subagent structure is ever needed; the parser here is
// transport-agnostic (it consumes stream-json events), so an SDK path emitting
// the same event shape reuses it unchanged.
//
// Run live:  tsx docs/evals/native-baseline/harness.ts <specPath> [--model sonnet]
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Task-001 provenance module (DR-7): every raw-data record is pinned + honesty-checked.
// Imported via a `.js` specifier resolving to the MCP-server `.ts` source — the
// established convention for `docs/evals/` harnesses (see `quality-ab/grade.ts`),
// so this pulls in no MCP runtime deps.
import {
  stampProvenance,
  assertMeasured,
  type Provenance,
  type ProvenanceStamped,
} from '../../../servers/exarchos-mcp/src/evals/provenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const NATIVE_BASELINE_DIR = __dirname;
export const REPO_ROOT = path.resolve(__dirname, '../../../');

// ─── Stream-json event shape (only the fields we read) ────────────────────────

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
 * A single parsed stream-json line. Claude Code's `--output-format stream-json`
 * emits one JSON object per line; we type only the fields this harness reads and
 * leave the rest loose (`unknown`) rather than pretend to model the whole schema.
 */
export interface StreamEvent {
  readonly type?: string;
  readonly subtype?: string;
  // assistant / user
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
  // task_started / task_notification (subagent lifecycle)
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
  // result
  readonly is_error?: boolean;
  readonly modelUsage?: Readonly<Record<string, ModelUsageEntry>>;
  readonly session_id?: string;
}

/** Result of leniently parsing a stream-json transcript. */
export interface ParsedTranscript {
  readonly events: readonly StreamEvent[];
  /** Count of non-blank lines that failed to JSON-parse (a trailing partial line, etc.). */
  readonly malformed: number;
}

/**
 * Parse a stream-json transcript (newline-delimited JSON) leniently: blank lines
 * are skipped and a line that fails to parse is counted (not thrown) so a
 * truncated final chunk never loses the events before it.
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

// ─── Per-subagent observation ─────────────────────────────────────────────────

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
 * How a subagent's {@link SubagentObservation.model} was determined — a
 * first-class honesty field, because the two real transcript variants differ:
 *   • `assistant`      — the subagent streamed its own `assistant` messages to the
 *                        parent transcript (with `parent_tool_use_id`), so its
 *                        model was read DIRECTLY off `message.model`.
 *   • `session-single` — the subagent's messages were NOT streamed (only its
 *                        `task_notification` surfaced); the model was RESOLVED
 *                        from the terminal `result.modelUsage` — but ONLY when the
 *                        whole session touched exactly one model, in which case
 *                        every subagent necessarily ran on it (a measured
 *                        inference, never a guess).
 *   • `unresolved`     — neither signal was available (e.g. a multi-model session
 *                        with no per-message linkage); the model stays `null`.
 */
export type ModelSource = 'assistant' | 'session-single' | 'unresolved';

/**
 * What native actually did for ONE dispatched subagent, harvested from the
 * transcript. `model` is the model native assigned this subagent (the spike's
 * central measurement); `toolUses`/`toolNames` are its verification/tool
 * behavior; `tokens` its spend.
 */
export interface SubagentObservation {
  readonly toolUseId: string;
  readonly taskId: string | null;
  readonly subagentType: string | null;
  readonly description: string | null;
  /** The model native assigned this subagent (null if unresolved — see {@link modelSource}). */
  readonly model: string | null;
  /** Provenance of {@link model} — direct vs. session-inferred vs. unresolved. */
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
 * Extract one {@link SubagentObservation} per dispatched subagent.
 *
 * Delegation is detected off `system/task_started` events (unambiguous — each is
 * a real Task dispatch), keyed by `tool_use_id`. A subagent's model + per-message
 * token usage + tool calls come from `assistant` events whose
 * `parent_tool_use_id` equals that `tool_use_id`. Its authoritative total-token
 * count + completion status come from the matching `system/task_notification`.
 *
 * Pure: derives everything from the passed events; reads no I/O and invents
 * nothing. Returns `[]` when no `task_started` events are present (→ the caller
 * treats that as BLOCKED, never a fabricated distribution).
 */
export function extractSubagents(events: readonly StreamEvent[]): SubagentObservation[] {
  // 1. Seed one record per dispatched subagent from task_started.
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

  // 2. Attribute assistant messages (model + tokens + tool calls) to their parent subagent.
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const parent = e.parent_tool_use_id;
    if (typeof parent !== 'string') continue; // null == main agent, not a subagent
    const rec = byToolUseId.get(parent);
    if (!rec) continue; // an assistant attributed to a dispatch we never saw start
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

  // 3. Overlay the authoritative completion facts from task_notification.
  for (const e of events) {
    if (e.type !== 'system' || e.subtype !== 'task_notification') continue;
    if (typeof e.tool_use_id !== 'string') continue;
    const rec = byToolUseId.get(e.tool_use_id);
    if (!rec) continue;
    if (e.status) rec.status = e.status;
    if (e.summary) rec.finalSummary = e.summary;
    const total = e.usage?.total_tokens;
    if (typeof total === 'number' && Number.isFinite(total)) rec.total = total;
    // task_notification's tool_uses is the authoritative count when the subagent
    // ran silently (no tool_use blocks surfaced in a captured assistant message).
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
 * Resolve subagents whose model could NOT be read from the parent transcript
 * (the common "notification-only" variant, where subagent `assistant` messages
 * are not streamed). When the terminal `result.modelUsage` lists exactly ONE
 * model, the whole session — subagents included — provably touched only that
 * model, so it is attributed to every unresolved subagent (`modelSource:
 * 'session-single'`). With zero or multiple session models the subagent stays
 * `unresolved` (never guessed). Pure; returns a new array.
 */
export function resolveSubagentModels(
  subagents: readonly SubagentObservation[],
  sessionModelUsage: Readonly<Record<string, ModelUsageEntry>>,
): SubagentObservation[] {
  const sessionModels = Object.keys(sessionModelUsage);
  const soleModel = sessionModels.length === 1 ? sessionModels[0] : null;
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
    if (e.type === 'result' && e.modelUsage) return e.modelUsage;
  }
  return {};
}

// ─── Model distribution (the spike's headline measurement) ────────────────────

/** How the distribution's per-subagent models were attributed overall. */
export type AttributionMode = 'per-subagent' | 'session-single' | 'mixed' | 'none';

export interface ModelDistribution {
  /** Count of dispatched subagents per assigned model id (subagents with a known model). */
  readonly perModel: Readonly<Record<string, number>>;
  /** Number of distinct models assigned across subagents. */
  readonly distinctModelCount: number;
  /**
   * True when every dispatched subagent resolved to ONE shared model and none
   * were left unattributed — i.e. native INHERITED a single model rather than
   * routing a mix. This is the boolean that answers "does native assign distinct
   * per-subagent models, or inherit one?"
   */
  readonly inheritsSingleModel: boolean;
  /** Subagents dispatched whose model could not be attributed at all. */
  readonly unattributed: number;
  /** How the models were determined (direct linkage vs. single-session inference). */
  readonly attributionMode: AttributionMode;
}

/**
 * Reduce the per-subagent observations to the model distribution. Expects
 * subagents already run through {@link resolveSubagentModels}. Counts only
 * subagents whose model was resolved; any left `null` is tallied under
 * `unattributed` (never guessed). `inheritsSingleModel` requires a single model
 * AND zero unattributed subagents, so a partial capture never over-claims.
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

function attributionModeOf(
  total: number,
  unattributed: number,
  sources: ReadonlySet<ModelSource>,
): AttributionMode {
  if (total === 0 || unattributed === total) return 'none';
  if (sources.has('unresolved')) return 'mixed'; // some resolved, some not
  if (sources.has('assistant') && sources.has('session-single')) return 'mixed';
  if (sources.has('session-single')) return 'session-single';
  return 'per-subagent';
}

// ─── Outcome records (measured vs. honest-blocked) ────────────────────────────

/** Common fields on every native-baseline record. */
interface NativeBaselineBase {
  /**
   * Honest provenance discriminant. BOTH outcomes are `measured` because both are
   * truthful records of a real run — a blocked record is a measured NEGATIVE, not
   * a modeled stand-in. `assertMeasured` therefore admits both; the guard against
   * a fabricated distribution is structural (see {@link BlockedNativeBaseline}).
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
 * Native did NOT delegate reproducibly (DR-7 fail-honest). Records the reason and
 * the fallbacks attempted. DELIBERATELY carries NO `modelDistribution`: when no
 * subagent was observed there is nothing to measure, and this harness refuses to
 * synthesize one. `subagents` is always empty.
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
 * Route a parsed transcript to the honest outcome:
 *   • ≥1 subagent observed  → {@link MeasuredNativeBaseline} with the real distribution.
 *   • 0 subagents observed  → {@link BlockedNativeBaseline} (no distribution, ever).
 *
 * The measured branch's distribution is DERIVED from the observed subagents —
 * there is no argument by which a caller can inject a hand-made distribution, so
 * a modeled substitute cannot enter through here. Pure (no I/O).
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
  // Fill session-single models for subagents whose messages weren't streamed to
  // the parent transcript (the notification-only variant) before tallying.
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
 * Stamp a record with Task-001 provenance and honesty-check it. Both a measured
 * and a blocked record are admissible (both are honest); a record self-flagged
 * `modeled`/`assumed` is rejected by {@link assertMeasured}.
 */
export function finalizeRecord(
  record: NativeBaselineRecord,
  provenance: Provenance,
): ProvenanceStamped<NativeBaselineRecord> {
  assertMeasured(record);
  return stampProvenance(record, provenance);
}

// ─── CSV emission (raw data for Task 007) ─────────────────────────────────────

/**
 * Render the measured per-subagent model distribution as CSV rows. A blocked
 * record yields NO distribution rows — only a single honest `blocked` marker row
 * — so a downstream reader can never mistake a negative result for a measurement.
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

// ─── Prompt + CLI arg builders (pure, testable) ───────────────────────────────

/**
 * Wrap a spec's text into a prompt that makes headless CC treat the spec AS its
 * plan and enter Task-tool delegation, one subagent per task. Kept deterministic
 * so a fixture prompt reproduces byte-for-byte.
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

// ─── Live driver (DI seam so tests never spawn `claude`) ──────────────────────

export interface ClaudeRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Injectable `claude` runner — the real one spawns the CLI; tests inject a fake. */
export type ClaudeRunner = (args: readonly string[]) => Promise<ClaudeRunResult>;

/** Default runner: spawn the real `claude` CLI and capture stdout. */
export const spawnClaude: ClaudeRunner = (args) =>
  new Promise<ClaudeRunResult>((resolve) => {
    execFile(
      'claude',
      [...args],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' },
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
  /** Short ref recorded on the result (e.g. the spec's path). */
  readonly specRef: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly dangerouslySkipPermissions?: boolean;
  /** Runner seam — defaults to {@link spawnClaude}; a test injects a canned transcript. */
  readonly runner?: ClaudeRunner;
}

export interface RunNativeBaselineResult {
  readonly record: NativeBaselineRecord;
  readonly transcript: string;
  readonly malformedLines: number;
}

/**
 * Drive a real `claude -p` run end-to-end and build the honest outcome record.
 *
 * The `claude` process failing to launch, exiting non-zero, or producing a
 * transcript with no delegation ALL degrade to a BLOCKED record (never a
 * fabricated distribution): DR-7 fail-honest. The raw transcript is returned so
 * the caller can persist it for provenance.
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

// ─── Script entry point (guarded — import-safe) ───────────────────────────────

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error('usage: tsx harness.ts <specPath> [--model <alias>]');
    process.exit(2);
  }
  const modelIdx = process.argv.indexOf('--model');
  const model = modelIdx >= 0 ? process.argv[modelIdx + 1] : 'sonnet';
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
