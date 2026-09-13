// Finds every Exarchos MCP call a skill's prose spells out, and every harness
// call it prescribes, as a located site.
//
// The extractor decides only what is mechanical: which text is a call, which
// tool and action it names, and whether the registry serves that pair. Which
// path a call belongs to is a judgement, and lives in the intent models where
// each one is recorded against the line it was made from.
//
// Tool names come from the registry snapshot rather than from this file, so a
// renamed or added composite tool is recognised without an edit here.

export interface RegistryTool {
  readonly name: string;
  readonly hidden: boolean;
  readonly actions: readonly string[];
}

export interface RegistrySnapshot {
  readonly counts: {
    readonly tools: number;
    readonly visibleTools: number;
    readonly actions: number;
  };
  readonly tools: readonly RegistryTool[];
}

export type SitePattern =
  | 'call-expression'
  | 'tool-verb-span'
  | 'tool-with-action-key'
  | 'bare-action-key'
  | 'harness-placeholder'
  | 'shell-fence';

/**
 * `registered` and `unregistered` apply to Exarchos calls. `ambiguous` is a bare
 * `action:` key whose name more than one tool serves, so no tool can be chosen.
 * `harness` is a native call the registry has no say over.
 */
export type SiteStatus = 'registered' | 'unregistered' | 'ambiguous' | 'harness';

export interface Site {
  /** 1-based line of the tool token (or of the key, for a bare action key). */
  readonly line: number;
  /** Last line the call's text spans; equal to `line` for single-line spellings. */
  readonly endLine: number;
  /** `tool.action`, `?.action` when no tool resolves, or `native:<name>`. */
  readonly call: string;
  readonly pattern: SitePattern;
  readonly status: SiteStatus;
  /** The `id:` argument of a call-expression, which is how a runbook fetch names its runbook. */
  readonly runbookId: string | null;
}

export type StepSurface = 'exarchos' | 'native' | 'decision';

export interface RunbookStepView {
  readonly call: string;
  readonly surface: StepSurface;
  readonly status: SiteStatus | 'decision';
}

export interface RunbookLike {
  readonly id: string;
  readonly phase: string;
  readonly steps: readonly { readonly tool: string; readonly action: string }[];
}

/**
 * Placeholders whose rendered form is a harness CALL. The runtime yaml defines
 * more tokens than these, but the rest name a tool or a hook in prose
 * (`TASK_TOOL`, `SUBAGENT_COMPLETION_HOOK`) or are not calls at all
 * (`COMMAND_PREFIX`), so counting them would count mentions.
 */
const HARNESS_CALL_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'SPAWN_AGENT_CALL',
  'SUBAGENT_RESULT_API',
  'CHAIN',
]);

const ACTION_KEY = /\baction\s*:\s*["']([\w-]+)["']/g;
const RUNBOOK_ID_KEY = /\bid\s*:\s*["']([\w-]+)["']/;
const SHELL_FENCE = /^[ \t]*(?:>[ \t]*)?```(?:bash|sh|shell)[ \t]*$/gm;
const PLACEHOLDER = /\{\{([A-Z][A-Z_]*)\b[^}]*\}\}/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function execAll(pattern: RegExp, text: string): RegExpExecArray[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const out: RegExpExecArray[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push(m);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Index of the brace closing the one at `open`, skipping quoted strings; -1 when unbalanced. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function statusOf(registry: RegistrySnapshot, tool: string, action: string | null): SiteStatus {
  const entry = registry.tools.find((t) => t.name === tool);
  if (entry === undefined || action === null) return 'unregistered';
  return entry.actions.includes(action) ? 'registered' : 'unregistered';
}

interface RawSite {
  readonly offset: number;
  readonly endOffset: number;
  readonly call: string;
  readonly pattern: SitePattern;
  readonly status: SiteStatus;
  readonly runbookId: string | null;
}

export function extractSites(text: string, registry: RegistrySnapshot): Site[] {
  if (registry.tools.length === 0) {
    throw new Error('registry snapshot names no tools; every call would read as unrecognised');
  }
  const starts = lineStarts(text);
  const toolAlternation = registry.tools
    .map((t) => t.name)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const consumedActionKeys = new Set<number>();
  const raw: RawSite[] = [];

  // A call expression: `tool({ ... action: "x" ... })`, whatever prefix a
  // runtime spelling puts before the tool name.
  for (const m of execAll(new RegExp(`(${toolAlternation})\\s*\\(\\s*\\{`), text)) {
    const tool = m[1] ?? '';
    const open = m.index + m[0].length - 1;
    const close = matchBrace(text, open);
    const blockEnd = close === -1 ? Math.min(text.length, open + 2000) : close + 1;
    const body = text.slice(open, blockEnd);
    const key = new RegExp(ACTION_KEY.source).exec(body);
    const action = key?.[1] ?? null;
    if (key !== null) consumedActionKeys.add(open + key.index);
    raw.push({
      offset: m.index,
      endOffset: blockEnd - 1,
      call: `${tool}.${action ?? '?'}`,
      pattern: 'call-expression',
      status: statusOf(registry, tool, action),
      runbookId: action === 'runbook' ? (RUNBOOK_ID_KEY.exec(body)?.[1] ?? null) : null,
    });
  }

  // Backtick spans naming a tool in prose: `tool verb`, `tool` `verb`, or
  // `tool` followed on the same line by an `action:` key.
  const toolOnly = new RegExp(`^(?:[\\w-]+:)?(${toolAlternation})$`);
  const toolVerb = new RegExp(`^(?:[\\w-]+:)?(${toolAlternation})\\s+([a-z][\\w-]*)$`);
  const bareWord = /^[a-z][\w-]*$/;
  let inFence = false;
  for (let li = 0; li < starts.length; li += 1) {
    const lineStart = starts[li] ?? 0;
    const lineEnd = li + 1 < starts.length ? (starts[li + 1] ?? text.length) - 1 : text.length;
    const lineText = text.slice(lineStart, lineEnd);
    if (/^[ \t]*(?:>[ \t]*)?```/.test(lineText)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const spans = execAll(/`([^`\n]+)`/, lineText);
    for (let si = 0; si < spans.length; si += 1) {
      const span = spans[si];
      if (span === undefined) continue;
      const content = span[1] ?? '';
      const spanOffset = lineStart + span.index;
      const verb = toolVerb.exec(content);
      if (verb !== null) {
        const tool = verb[1] ?? '';
        const action = verb[2] ?? '';
        raw.push({
          offset: spanOffset,
          endOffset: spanOffset,
          call: `${tool}.${action}`,
          pattern: 'tool-verb-span',
          status: statusOf(registry, tool, action),
          runbookId: null,
        });
        continue;
      }
      const only = toolOnly.exec(content);
      if (only === null) continue;
      const tool = only[1] ?? '';
      const next = spans[si + 1];
      const gap = next === undefined ? '' : lineText.slice(span.index + span[0].length, next.index);
      if (next !== undefined && gap.trim() === '' && bareWord.test(next[1] ?? '')) {
        const action = next[1] ?? '';
        raw.push({
          offset: spanOffset,
          endOffset: spanOffset,
          call: `${tool}.${action}`,
          pattern: 'tool-verb-span',
          status: statusOf(registry, tool, action),
          runbookId: null,
        });
        si += 1;
        continue;
      }
      const rest = lineText.slice(span.index + span[0].length);
      const key = new RegExp(ACTION_KEY.source).exec(rest);
      if (key === null) continue;
      const keyOffset = lineStart + span.index + span[0].length + key.index;
      if (consumedActionKeys.has(keyOffset)) continue;
      consumedActionKeys.add(keyOffset);
      const action = key[1] ?? '';
      raw.push({
        offset: spanOffset,
        endOffset: keyOffset,
        call: `${tool}.${action}`,
        pattern: 'tool-with-action-key',
        status: statusOf(registry, tool, action),
        runbookId: null,
      });
    }
  }

  // An `action:` key with no tool beside it. The tool is whichever one serves
  // that action name, and only when exactly one does.
  for (const m of execAll(ACTION_KEY, text)) {
    if (consumedActionKeys.has(m.index)) continue;
    const action = m[1] ?? '';
    const owners = registry.tools.filter((t) => t.actions.includes(action));
    const owner = owners.length === 1 ? owners[0] : undefined;
    raw.push({
      offset: m.index,
      endOffset: m.index,
      call: owner === undefined ? `?.${action}` : `${owner.name}.${action}`,
      pattern: 'bare-action-key',
      status: owner !== undefined ? 'registered' : owners.length > 1 ? 'ambiguous' : 'unregistered',
      runbookId: null,
    });
  }

  for (const m of execAll(PLACEHOLDER, text)) {
    const name = m[1] ?? '';
    if (!HARNESS_CALL_PLACEHOLDERS.has(name)) continue;
    raw.push({
      offset: m.index,
      endOffset: m.index + m[0].length - 1,
      call: `native:${name}`,
      pattern: 'harness-placeholder',
      status: 'harness',
      runbookId: null,
    });
  }

  // A fenced shell block is one harness call; it spans to its closing fence.
  for (const m of execAll(SHELL_FENCE, text)) {
    const afterOpen = m.index + m[0].length;
    const close = /^[ \t]*(?:>[ \t]*)?```[ \t]*$/m.exec(text.slice(afterOpen));
    raw.push({
      offset: m.index,
      endOffset: close === null ? m.index : afterOpen + close.index,
      call: 'native:Bash',
      pattern: 'shell-fence',
      status: 'harness',
      runbookId: null,
    });
  }

  return raw
    .sort((a, b) => a.offset - b.offset)
    .map((r) => ({
      line: lineOf(starts, r.offset),
      endLine: lineOf(starts, Math.max(r.offset, r.endOffset)),
      call: r.call,
      pattern: r.pattern,
      status: r.status,
      runbookId: r.runbookId,
    }));
}

export function classifyRunbookSteps(runbook: RunbookLike, registry: RegistrySnapshot): RunbookStepView[] {
  return runbook.steps.map((step) => {
    if (step.tool === 'none') {
      return { call: `decide.${step.action}`, surface: 'decision', status: 'decision' };
    }
    if (step.tool.startsWith('native:')) {
      return { call: `${step.tool}.${step.action}`, surface: 'native', status: 'harness' };
    }
    return {
      call: `${step.tool}.${step.action}`,
      surface: 'exarchos',
      status: statusOf(registry, step.tool, step.action),
    };
  });
}

/** Line of the single occurrence of `needle`, or a reason it does not name one line. */
export function locateNeedle(text: string, needle: string): { line: number } | { error: string } {
  if (needle.length === 0) return { error: 'empty needle' };
  const first = text.indexOf(needle);
  if (first === -1) return { error: `not found: ${JSON.stringify(needle)}` };
  if (text.indexOf(needle, first + 1) !== -1) {
    return { error: `occurs more than once: ${JSON.stringify(needle)}` };
  }
  return { line: lineOf(lineStarts(text), first) };
}

/** `references/*.md` files a skill body names, deduplicated and sorted. */
export function namedReferenceFiles(text: string): string[] {
  return [...new Set(execAll(/references\/[\w.-]+\.md/, text).map((m) => m[0]))].sort();
}
