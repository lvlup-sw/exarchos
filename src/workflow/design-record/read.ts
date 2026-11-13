/** Read one bounded design record and retain the exact source for later validators. */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import {
  DesignPlanSchema,
  type DesignRecordReadResult,
  type RequirementDefinition,
  type SourceSpan,
} from './schema.js';

export interface DesignRecordLimits {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 128;

/** Freeze nested arrays and objects before a snapshot leaves the reader. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Build spans from line starts without rescanning the source for each task. */
function spanFactory(text: string): (start: number, end: number) => SourceSpan {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid;
    }
    return lo + 1;
  };
  return (start, end) => ({ start, end, startLine: lineAt(start), endLine: lineAt(Math.max(start, end - 1)) });
}

/** CommonMark HTML block endings keep raw HTML outside the plan authority. */
function htmlBlockEnd(line: string, inParagraph: boolean): RegExp | undefined {
  if (/^ {0,3}<(pre|script|style|textarea)(?=[ \t>]|$)/i.test(line)) return /<\/(pre|script|style|textarea)>/i;
  if (/^ {0,3}<!--/.test(line)) return /-->/;
  if (/^ {0,3}<\?/.test(line)) return /\?>/;
  if (/^ {0,3}<![A-Za-z]/.test(line)) return />/;
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return /\]\]>/;
  const blockTags = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
  if (new RegExp('^ {0,3}</?(' + blockTags + ')(?=[ \\t>]|/>|$)', 'i').test(line)) return /^[ \t]*$/;
  if (inParagraph) return undefined;
  const attribute = '[ \\t]+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:[ \\t]*=[ \\t]*(?:[^ \\t"\'=<>`]+|"[^"\\n]*"|\'[^\'\\n]*\'))?';
  const complete = new RegExp('^ {0,3}(?:<(?!(?:pre|script|style|textarea)(?=[ \\t/>]))[A-Za-z][A-Za-z0-9-]*(?:' + attribute + ')*[ \\t]*/?>|</[A-Za-z][A-Za-z0-9-]*[ \\t]*>)[ \\t]*$', 'i');
  return complete.test(line) ? /^[ \t]*$/ : undefined;
}

/** Recognize fences before headings so examples cannot define a plan or a requirement. */
function scanMarkdown(text: string, span: ReturnType<typeof spanFactory>) {
  const blocks: { info: string; start: number; end: number }[] = [];
  const definitions: RequirementDefinition[] = [];
  let fence: { marker: string; length: number; info: string; start: number; indent: number; nested: boolean } | undefined;
  let html: { end: RegExp; indent: number } | undefined;
  let regionLevel: number | undefined;
  let listIndent: number | undefined;
  let previous: { title: string; offset: number } | undefined;
  const lines = text.matchAll(/[^\n]*(?:\n|$)/g);
  for (const match of lines) {
    const raw = match[0];
    if (raw === '') continue;
    const line = raw.replace(/\r?\n$/, '').replace(match.index === 0 ? /^\uFEFF/ : /$^/, '');
    const offset = match.index;
    if (fence?.nested && line.trim() !== '' && !line.startsWith(' '.repeat(fence.indent))) fence = undefined;
    if (html && html.indent > 0 && line.trim() !== '' && !line.startsWith(' '.repeat(html.indent))) html = undefined;
    if (fence !== undefined) {
      previous = undefined;
      const closing = new RegExp('^ {0,' + (fence.indent + 3) + '}(`{3,}|~{3,})[ \t]*$').exec(line);
      if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.length) {
        if (!fence.nested && fence.info.startsWith('exarchos-plan')) blocks.push({ info: fence.info, start: fence.start, end: offset });
        fence = undefined;
      }
      continue;
    }
    if (html) {
      if (html.end.test(line)) html = undefined;
      previous = undefined;
      continue;
    }
    const item = /^( {0,3})(?:[-+*]|[0-9]{1,9}[.)])([ \t]+)(.*)$/.exec(line);
    if (item) listIndent = line.length - item[3]!.length;
    else if (line.trim() !== '' && listIndent !== undefined && !line.startsWith(' '.repeat(listIndent))) listIndent = undefined;
    const nested = listIndent !== undefined;
    const content = item ? item[3]! : nested ? line.slice(listIndent) : line;
    const htmlEnd = htmlBlockEnd(content, previous !== undefined);
    if (htmlEnd) {
      if (!htmlEnd.test(content)) html = { end: htmlEnd, indent: listIndent ?? 0 };
      previous = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (opening && !(opening[1]![0] === '`' && opening[2]!.includes('`'))) {
      previous = undefined;
      fence = { marker: opening[1]![0]!, length: opening[1]!.length, info: opening[2]!.trim(), start: offset + raw.length, indent: listIndent ?? 0, nested };
      continue;
    }
    if (nested) { previous = undefined; continue; }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(line);
    const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    const setext = underline && previous;
    if (!heading && !setext) {
      previous = /^( {4}|\t| {0,3}>)/.test(line) || line.trim() === '' ? undefined : { title: line.trim(), offset };
      continue;
    }
    const level = heading ? heading[1]!.length : underline![1]![0] === '=' ? 1 : 2;
    const title = heading ? heading[2]!.replace(/[ \t]+#+[ \t]*$/, '') : previous!.title;
    const headingStart = heading ? offset : previous!.offset;
    previous = undefined;
    if (regionLevel !== undefined && level <= regionLevel) regionLevel = undefined;
    if (title === 'Design & Rationale') regionLevel = level;
    else if (regionLevel !== undefined) {
      const requirement = /^(DR-[1-9][0-9]*)(?=[: \t]|$)/.exec(title);
      if (requirement) definitions.push({ id: requirement[1]!, title, span: span(headingStart, offset + line.length) });
    }
  }
  if (fence && !fence.nested && fence.info.startsWith('exarchos-plan')) throw new Error('Unterminated typed plan fence');
  return { blocks, definitions };
}

/** Strict JSON syntax is checked first. This walk rejects decoded duplicate keys and records task spans. */
function jsonTaskSpans(body: string, start: number, maxDepth: number, span: ReturnType<typeof spanFactory>): SourceSpan[] {
  const token = /\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,])/y;
  let offset = 0;
  const tasks: SourceSpan[] = [];
  const next = (): string => {
    token.lastIndex = offset;
    const match = token.exec(body);
    if (!match) throw new Error('Invalid JSON token');
    offset = token.lastIndex;
    return match[1]!;
  };
  const walk = (keys: readonly (string | number)[], depth: number): void => {
    if (depth > maxDepth) throw new Error('Plan exceeds the JSON depth limit');
    while (/\s/.test(body[offset] ?? '') && offset < body.length) offset++;
    const from = offset;
    const value = next();
    if (value === '{') {
      const seen = new Set<string>();
      let key = next();
      while (key !== '}') {
        const decoded: unknown = JSON.parse(key);
        if (typeof decoded !== 'string') throw new Error('Invalid JSON key');
        if (seen.has(decoded)) throw new Error(`Duplicate JSON key: ${decoded}`);
        seen.add(decoded);
        next();
        walk([...keys, decoded], depth + 1);
        if (next() === '}') break;
        key = next();
      }
    } else if (value === '[') {
      const saved = offset;
      if (next() !== ']') {
        offset = saved;
        let index = 0;
        do { walk([...keys, index++], depth + 1); } while (next() !== ']');
      }
    }
    if (keys.length === 2 && keys[0] === 'tasks' && typeof keys[1] === 'number') {
      tasks[keys[1]] = span(start + from, start + offset);
    }
  };
  walk([], 0);
  return tasks;
}

/** Classify bytes without reading task prose or changing identifiers. */
export function readDesignRecord(bytes: Uint8Array, reference: string, limits: DesignRecordLimits = {}): DesignRecordReadResult {
  try {
    const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 1) {
      throw new Error('Invalid design record limits');
    }
    if (bytes.length > maxBytes) throw new Error('Design record exceeds the byte limit');
    const owned = Uint8Array.from(bytes);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(owned);
    const span = spanFactory(text);
    const { blocks, definitions } = scanMarkdown(text, span);
    if (blocks.length === 0) return { kind: 'legacy', reference };
    if (blocks.length !== 1) throw new Error('Expected exactly one typed plan block');
    const block = blocks[0]!;
    if (block.info !== 'exarchos-plan-v1') throw new Error('Unsupported typed plan fence');
    const body = text.slice(block.start, block.end);
    const value: unknown = JSON.parse(body);
    const spans = jsonTaskSpans(body, block.start, maxDepth, span);
    const plan = DesignPlanSchema.parse(value);
    return freeze({
      kind: 'typed',
      snapshot: {
        reference,
        digest: createHash('sha256').update(owned).digest('hex'),
        rawBytes: Array.from(owned),
        version: plan.version,
        requirements: plan.requirements,
        tasks: plan.tasks.map((task, index) => ({ ...task, span: spans[index]! })),
        definitions,
        planSpan: span(block.start, block.end),
      },
    });
  } catch (error) {
    return { kind: 'invalid', reference, message: error instanceof Error ? error.message : 'Cannot read design record' };
  }
}

/** Read at most the byte limit plus one from a lexically contained reference. Symbolic links retain their existing behavior. */
export async function readDesignRecordAt(
  checkout: string, reference: string, limits: DesignRecordLimits = {},
): Promise<DesignRecordReadResult> {
  try {
    const root = path.resolve(checkout);
    const target = path.resolve(root, reference);
    const relative = path.relative(root, target);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Design reference leaves the checkout');
    }
    const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid design record byte limit');
    const handle = await open(target, 'r');
    try {
      const bytes = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      return readDesignRecord(bytes.subarray(0, length), reference, limits);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { kind: 'invalid', reference, message: error instanceof Error ? error.message : 'Cannot read design record' };
  }
}
