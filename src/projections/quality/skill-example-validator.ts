// ─── Skill / Command Example Validator ──────────────────────────────────────
//
// Documentation across `skills-src/**` and `commands/**` embeds tool-invocation
// examples of the form:
//
//     exarchos_workflow({ action: "describe", actions: ["update", "init"] })
//
// These examples drift silently from the live MCP schemas — an action gets
// renamed, a param is added/removed, a value type changes — and nothing
// mechanically catches it, so the docs quietly start to lie (P02-07 / WFQ-011…015).
//
// This module is that mechanical check. It extracts the structured
// call-expression examples from Markdown and validates each against the SAME
// oracle the runtime surfaces to agents via `exarchos_view describe`:
// `zodToJsonSchema(action.schema)`. Unknown tools, unknown/stale action names,
// unknown/misspelled params, and type-incompatible literal values are reported.
//
// Design notes:
//   • The oracle is derived from the registry at call time (never a hand-kept
//     duplicate list), so it can never drift from what agents actually see.
//   • Examples are tolerant-parsed: doc snippets legitimately contain JS the way
//     an agent would type it (arrow functions, `.map(...)`, comments, trailing
//     commas, `<placeholder>` strings). We validate the parts we CAN parse
//     unambiguously — the action discriminator, the top-level param keys, and
//     literal value types — and abstain on the parts we cannot (nested
//     expressions), rather than emitting false positives.
//   • Validation is KEY-level, not full-schema: doc examples are intentionally
//     partial (they show only the relevant params), so a missing *required*
//     field is NOT an error. Presence of an unknown key IS.
// ────────────────────────────────────────────────────────────────────────────

import { zodToJsonSchema } from '../../adapters/json-schema.js';
import type { CompositeTool } from '../../registry.js';

/** JSON Schema primitive type labels emitted by {@link zodToJsonSchema}. */
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';

/** Normalized per-property constraints extracted from a live action schema. */
export interface PropertySchema {
  /** Acceptable JSON types. Empty = unconstrained (e.g. a union we don't narrow). */
  readonly types: readonly JsonType[];
  /** Enum members, when the property is a closed set of literals. */
  readonly enumValues?: readonly (string | number | boolean)[];
  /** Inclusive lower bound (JSON Schema `minimum`), when constrained. */
  readonly minimum?: number;
  /** Inclusive upper bound (JSON Schema `maximum`), when constrained. */
  readonly maximum?: number;
  /** Exclusive lower bound (JSON Schema `exclusiveMinimum`), when constrained. */
  readonly exclusiveMinimum?: number;
  /** Exclusive upper bound (JSON Schema `exclusiveMaximum`), when constrained. */
  readonly exclusiveMaximum?: number;
}

/** Normalized schema for a single tool action. */
export interface ActionSchema {
  readonly properties: Readonly<Record<string, PropertySchema>>;
  /** When false, keys outside {@link properties} (plus `action`) are rejected. */
  readonly additionalProperties: boolean;
}

/** The validation oracle: tool name → action name → normalized schema. */
export interface SchemaOracle {
  readonly tools: Readonly<Record<string, Readonly<Record<string, ActionSchema>>>>;
}

/** Runtime kind of a parsed example value. */
export type ExampleValueKind =
  | 'string'
  | 'placeholder'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'null'
  | 'array'
  | 'object'
  | 'expression';

export interface ExampleValue {
  readonly kind: ExampleValueKind;
  /** Raw source text of the value. */
  readonly raw: string;
  /** For string/placeholder kinds: the unquoted inner text. */
  readonly text?: string;
}

export interface ToolExample {
  readonly tool: string;
  /** The `action` discriminator, or null when absent / non-literal. */
  readonly action: string | null;
  readonly params: Readonly<Record<string, ExampleValue>>;
  readonly file: string;
  /** 1-based line of the call site. */
  readonly line: number;
  readonly raw: string;
}

export type IssueCode =
  | 'UNKNOWN_TOOL'
  | 'MISSING_ACTION'
  | 'UNKNOWN_ACTION'
  | 'UNKNOWN_PARAM'
  | 'TYPE_MISMATCH'
  | 'ENUM_MISMATCH'
  | 'RANGE_MISMATCH';

export interface ValidationIssue {
  readonly code: IssueCode;
  readonly file: string;
  readonly line: number;
  readonly tool: string;
  readonly action: string | null;
  readonly param?: string;
  readonly message: string;
}

// ─── Oracle construction ────────────────────────────────────────────────────

interface RawJsonSchema {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, RawJsonSchema>;
  additionalProperties?: boolean | RawJsonSchema;
  anyOf?: unknown[];
  oneOf?: unknown[];
  minimum?: unknown;
  maximum?: unknown;
  exclusiveMinimum?: unknown;
  exclusiveMaximum?: unknown;
}

function toJsonTypes(value: string | string[] | undefined): JsonType[] {
  if (value === undefined) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.filter((t): t is JsonType =>
    t === 'string' ||
    t === 'number' ||
    t === 'integer' ||
    t === 'boolean' ||
    t === 'array' ||
    t === 'object' ||
    t === 'null',
  );
}

function normalizeProperty(prop: RawJsonSchema): PropertySchema {
  const types = toJsonTypes(prop.type);
  const enumValues = Array.isArray(prop.enum)
    ? prop.enum.filter(
        (v): v is string | number | boolean =>
          typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
      )
    : undefined;
  // Numeric bounds are only meaningful for number/integer properties. Draft
  // 2020-12 (what zodToJsonSchema emits) renders exclusive bounds as numbers,
  // not booleans, so a plain typeof-number guard is sufficient.
  const bounds: {
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
  } = {};
  if (typeof prop.minimum === 'number') bounds.minimum = prop.minimum;
  if (typeof prop.maximum === 'number') bounds.maximum = prop.maximum;
  if (typeof prop.exclusiveMinimum === 'number') bounds.exclusiveMinimum = prop.exclusiveMinimum;
  if (typeof prop.exclusiveMaximum === 'number') bounds.exclusiveMaximum = prop.exclusiveMaximum;
  const base: PropertySchema = { types, ...bounds };
  return enumValues && enumValues.length > 0 ? { ...base, enumValues } : base;
}

/** Convert a single Zod action schema into the normalized {@link ActionSchema}. */
export function normalizeActionSchema(jsonSchema: unknown): ActionSchema {
  const js = (jsonSchema ?? {}) as RawJsonSchema;
  const rawProps = js.properties ?? {};
  const properties: Record<string, PropertySchema> = {};
  for (const [key, prop] of Object.entries(rawProps)) {
    properties[key] = normalizeProperty(prop);
  }
  // zodToJsonSchema emits `additionalProperties: false` for strict objects.
  // Absent / non-false ⇒ treat as permissive (don't flag unknown keys).
  const additionalProperties = js.additionalProperties !== false;
  return { properties, additionalProperties };
}

/**
 * Build the validation oracle from the live registry. Uses the exact same
 * `zodToJsonSchema(action.schema)` projection the `describe` handler surfaces,
 * so the docs are validated against what agents actually observe at runtime.
 */
export function buildOracleFromRegistry(registry: readonly CompositeTool[]): SchemaOracle {
  const tools: Record<string, Record<string, ActionSchema>> = {};
  for (const tool of registry) {
    const actions: Record<string, ActionSchema> = {};
    for (const action of tool.actions) {
      actions[action.name] = normalizeActionSchema(zodToJsonSchema(action.schema));
    }
    tools[tool.name] = actions;
  }
  return { tools };
}

// ─── Example extraction ─────────────────────────────────────────────────────

const TOOL_CALL_RE = /exarchos_(workflow|event|orchestrate|view|sync)\s*\(\s*\{/g;

/** A string value counts as a placeholder (type-wildcard) when it carries doc
 *  placeholder markers rather than a concrete literal. */
function isPlaceholderText(inner: string): boolean {
  return inner.includes('<') || inner.includes('>') || inner === '...' || inner.trim() === '';
}

/**
 * Scan from an opening `{` (or `[`) and return the index of its matching close,
 * respecting string literals and nested brackets/parens. Returns -1 if
 * unterminated.
 */
function findMatchingClose(text: string, openIndex: number): number {
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString !== null) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === inString) inString = null;
      continue;
    }
    // Comments must be skipped BEFORE string detection: a `//` line comment can
    // contain an unbalanced apostrophe (e.g. `// resolves the delegation's
    // worktree`) that would otherwise open a phantom string and corrupt the
    // brace match, swallowing the rest of the document.
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // consume the closing '/'
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
    } else if (c === '{' || c === '[' || c === '(') {
      depth++;
    } else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split an object body (text between the outer braces) into top-level segments
 *  at depth-0 commas, honoring strings and stripping `//` and block comments. */
function splitTopLevelSegments(body: string): string[] {
  const segments: string[] = [];
  let current = '';
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const next = body[i + 1];
    if (inString !== null) {
      current += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && next === '/') {
      // Line comment: skip to end of line.
      while (i < body.length && body[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      // Block comment: skip to closing */.
      i += 2;
      while (i < body.length && !(body[i] === '*' && body[i + 1] === '/')) i++;
      i++; // consume the '/'
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      current += c;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) {
      segments.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim() !== '') segments.push(current);
  return segments;
}

function classifyValue(rawInput: string): ExampleValue {
  const raw = rawInput.trim();
  const first = raw[0];
  if (first === '"' || first === "'" || first === '`') {
    // Extract inner text up to matching quote.
    const closeIdx = findClosingQuote(raw, first);
    const inner = closeIdx > 0 ? raw.slice(1, closeIdx) : raw.slice(1);
    return {
      kind: isPlaceholderText(inner) ? 'placeholder' : 'string',
      raw,
      text: inner,
    };
  }
  if (raw === 'true' || raw === 'false') return { kind: 'boolean', raw };
  if (raw === 'null') return { kind: 'null', raw };
  if (/^-?\d+$/.test(raw)) return { kind: 'integer', raw };
  if (/^-?\d*\.\d+$/.test(raw)) return { kind: 'number', raw };
  if (first === '[') return { kind: 'array', raw };
  if (first === '{') return { kind: 'object', raw };
  return { kind: 'expression', raw };
}

function findClosingQuote(raw: string, quote: string): number {
  let escaped = false;
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === quote) return i;
  }
  return -1;
}

/** Parse an object body into { key: ExampleValue } pairs. Segments without a
 *  `key:` (spreads, bare expressions) are ignored. */
function parseParams(body: string): Record<string, ExampleValue> {
  const params: Record<string, ExampleValue> = {};
  for (const segment of splitTopLevelSegments(body)) {
    const seg = segment.trim();
    if (seg === '') continue;
    const parsed = parseKeyValue(seg);
    if (parsed) params[parsed.key] = parsed.value;
  }
  return params;
}

function parseKeyValue(seg: string): { key: string; value: ExampleValue } | null {
  let key: string;
  let rest: string;
  const first = seg[0];
  if (first === '"' || first === "'") {
    const closeIdx = findClosingQuote(seg, first);
    if (closeIdx < 0) return null;
    key = seg.slice(1, closeIdx);
    rest = seg.slice(closeIdx + 1).trim();
  } else {
    const m = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(seg);
    const captured = m?.[1];
    if (captured === undefined) return null;
    key = captured;
    rest = seg.slice(captured.length).trim();
  }
  if (!rest.startsWith(':')) return null;
  const valueRaw = rest.slice(1).trim();
  if (valueRaw === '') return null;
  return { key, value: classifyValue(valueRaw) };
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/**
 * Extract every structured tool-invocation example from a Markdown document.
 * Recognizes `exarchos_<tool>({ ... })` call expressions (single- or multi-line,
 * with or without an `exarchos:` / `mcp__…__` namespace prefix).
 */
export function extractToolExamples(markdown: string, file = '<memory>'): ToolExample[] {
  const examples: ToolExample[] = [];
  TOOL_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_RE.exec(markdown)) !== null) {
    const tool = `exarchos_${match[1]}`;
    // The regex ends at the `{`; find its position (last char of the match).
    const openBrace = markdown.indexOf('{', match.index);
    if (openBrace < 0) continue;
    const close = findMatchingClose(markdown, openBrace);
    if (close < 0) continue;
    // Strip Markdown blockquote prefixes (`> `) that lead each body line when
    // the example is embedded in a blockquote — otherwise the `>` masks the
    // param key and the example parses as action-less. Blockquote markers only
    // appear at line start, so `>` inside a value (e.g. `"<PR diff>"`) is safe.
    const body = markdown.slice(openBrace + 1, close).replace(/^[ \t]*>+[ \t]?/gm, '');
    const params = parseParams(body);
    const actionVal = params['action'];
    let action: string | null = null;
    if (actionVal && (actionVal.kind === 'string' || actionVal.kind === 'placeholder')) {
      action = actionVal.text ?? null;
    }
    // Remove the discriminator from params — it's validated separately.
    const rest: Record<string, ExampleValue> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k !== 'action') rest[k] = v;
    }
    examples.push({
      tool,
      action,
      params: rest,
      file,
      line: lineOf(markdown, match.index),
      raw: markdown.slice(match.index, close + 1),
    });
    // Advance past this call so nested matches inside the body aren't double-counted.
    TOOL_CALL_RE.lastIndex = close + 1;
  }
  return examples;
}

// ─── Validation ─────────────────────────────────────────────────────────────

function valueKindToJsonTypes(kind: ExampleValueKind): JsonType[] {
  switch (kind) {
    case 'string':
      return ['string'];
    case 'integer':
      return ['integer', 'number'];
    case 'number':
      return ['number'];
    case 'boolean':
      return ['boolean'];
    case 'array':
      return ['array'];
    case 'object':
      return ['object'];
    case 'null':
      return ['null'];
    default:
      return [];
  }
}

/** Validate a single extracted example against the oracle. */
export function validateExample(example: ToolExample, oracle: SchemaOracle): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const base = { file: example.file, line: example.line, tool: example.tool, action: example.action };

  const toolActions = oracle.tools[example.tool];
  if (!toolActions) {
    issues.push({
      ...base,
      code: 'UNKNOWN_TOOL',
      message: `Unknown tool "${example.tool}". Known tools: ${Object.keys(oracle.tools).join(', ')}.`,
    });
    return issues;
  }

  if (example.action === null) {
    issues.push({
      ...base,
      code: 'MISSING_ACTION',
      message: `Example for "${example.tool}" has no literal "action" discriminator.`,
    });
    return issues;
  }

  const actionSchema = toolActions[example.action];
  if (!actionSchema) {
    issues.push({
      ...base,
      code: 'UNKNOWN_ACTION',
      message:
        `Unknown action "${example.action}" for ${example.tool}. ` +
        `Valid actions: ${Object.keys(toolActions).join(', ')}.`,
    });
    return issues;
  }

  for (const [key, value] of Object.entries(example.params)) {
    const prop = actionSchema.properties[key];
    if (!prop) {
      if (!actionSchema.additionalProperties) {
        issues.push({
          ...base,
          code: 'UNKNOWN_PARAM',
          param: key,
          message:
            `Unknown param "${key}" for ${example.tool}.${example.action}. ` +
            `Valid params: ${Object.keys(actionSchema.properties).join(', ') || '(none)'}.`,
        });
      }
      continue;
    }

    // Placeholder strings and un-parseable expressions are type-wildcards:
    // docs use `"<id>"` for every field regardless of the real type.
    if (value.kind === 'placeholder' || value.kind === 'expression' || value.kind === 'null') {
      continue;
    }

    // Enum membership (only for concrete string/number/boolean literals).
    if (prop.enumValues && prop.enumValues.length > 0) {
      const literal = value.kind === 'string' ? value.text : coerceLiteral(value);
      if (literal !== undefined && !prop.enumValues.includes(literal)) {
        issues.push({
          ...base,
          code: 'ENUM_MISMATCH',
          param: key,
          message:
            `Param "${key}" value ${JSON.stringify(literal)} for ${example.tool}.${example.action} ` +
            `is not one of: ${prop.enumValues.map((v) => JSON.stringify(v)).join(', ')}.`,
        });
      }
      continue;
    }

    // Type compatibility for concrete literals against a constrained property.
    if (prop.types.length === 0) continue; // unconstrained (union) — abstain.
    const candidateTypes = valueKindToJsonTypes(value.kind);
    if (candidateTypes.length === 0) continue;
    const compatible = candidateTypes.some((t) => prop.types.includes(t));
    if (!compatible) {
      issues.push({
        ...base,
        code: 'TYPE_MISMATCH',
        param: key,
        message:
          `Param "${key}" has ${value.kind} value ${value.raw} but ${example.tool}.${example.action} ` +
          `expects type ${prop.types.join(' | ')}.`,
      });
      continue;
    }

    // Numeric range check for concrete integer/number literals against a
    // bounded property (e.g. a threshold declared 0..1 documented as `80`).
    if (value.kind === 'integer' || value.kind === 'number') {
      const num = Number(value.raw);
      if (Number.isFinite(num)) {
        const violation = rangeViolation(num, prop);
        if (violation !== null) {
          issues.push({
            ...base,
            code: 'RANGE_MISMATCH',
            param: key,
            message:
              `Param "${key}" value ${value.raw} for ${example.tool}.${example.action} ` +
              `is out of range: ${violation}.`,
          });
        }
      }
    }
  }

  return issues;
}

function coerceLiteral(value: ExampleValue): string | number | boolean | undefined {
  if (value.kind === 'boolean') return value.raw === 'true';
  if (value.kind === 'integer' || value.kind === 'number') return Number(value.raw);
  return undefined;
}

/**
 * Return a human-readable description of the first bound `num` violates, or
 * `null` when it satisfies every declared bound. Inclusive (`minimum`/
 * `maximum`) and exclusive (`exclusiveMinimum`/`exclusiveMaximum`) bounds are
 * both honored; a property with no numeric bounds always passes.
 */
function rangeViolation(num: number, prop: PropertySchema): string | null {
  if (prop.minimum !== undefined && num < prop.minimum) {
    return `must be >= ${prop.minimum}`;
  }
  if (prop.maximum !== undefined && num > prop.maximum) {
    return `must be <= ${prop.maximum}`;
  }
  if (prop.exclusiveMinimum !== undefined && num <= prop.exclusiveMinimum) {
    return `must be > ${prop.exclusiveMinimum}`;
  }
  if (prop.exclusiveMaximum !== undefined && num >= prop.exclusiveMaximum) {
    return `must be < ${prop.exclusiveMaximum}`;
  }
  return null;
}

/** Extract and validate every example in a Markdown document. */
export function validateMarkdown(
  markdown: string,
  file: string,
  oracle: SchemaOracle,
): ValidationIssue[] {
  return extractToolExamples(markdown, file).flatMap((ex) => validateExample(ex, oracle));
}
