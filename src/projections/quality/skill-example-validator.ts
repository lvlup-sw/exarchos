/**
 * Checks the tool-call examples in Markdown against the live MCP schemas.
 *
 * An example has the form `exarchos_workflow({ action: "describe", actions: ["init"] })`.
 * The oracle is `zodToJsonSchema(action.schema)` for each registry action, the same
 * projection that `exarchos_view describe` shows. The check reports an unknown tool, a
 * missing or unknown action, an unknown param, and a literal with a wrong type, enum
 * member, or range.
 *
 * The parser is tolerant. It checks the action, the top-level param keys, and literal
 * types, and it ignores nested expressions. Examples are partial, so a missing required
 * param is not an error.
 */

import { zodToJsonSchema } from '../../utils/json-schema.js';
import type { CompositeTool } from '../../registry.js';

/** JSON Schema primitive type labels emitted by {@link zodToJsonSchema}. */
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';

/** Normalized per-property constraints extracted from a live action schema. */
export interface PropertySchema {
  /** Acceptable JSON types. An empty list means no constraint, for example for a union. */
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

/**
 * Normalizes one property. Draft 2020-12 output from `zodToJsonSchema` gives exclusive
 * bounds as numbers, not booleans, so a `typeof` number check reads each bound.
 */
function normalizeProperty(prop: RawJsonSchema): PropertySchema {
  const types = toJsonTypes(prop.type);
  const enumValues = Array.isArray(prop.enum)
    ? prop.enum.filter(
        (v): v is string | number | boolean =>
          typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
      )
    : undefined;
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

/**
 * Converts the JSON Schema of one action into the normalized {@link ActionSchema}.
 * Only `additionalProperties: false`, the output for a strict object, rejects unknown keys.
 */
export function normalizeActionSchema(jsonSchema: unknown): ActionSchema {
  const js = (jsonSchema ?? {}) as RawJsonSchema;
  const rawProps = js.properties ?? {};
  const properties: Record<string, PropertySchema> = {};
  for (const [key, prop] of Object.entries(rawProps)) {
    properties[key] = normalizeProperty(prop);
  }
  const additionalProperties = js.additionalProperties !== false;
  return { properties, additionalProperties };
}

/**
 * Builds the oracle from the live registry, with the same `zodToJsonSchema(action.schema)`
 * projection that the `describe` handler shows to agents.
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

const TOOL_CALL_RE = /exarchos_(workflow|event|orchestrate|view|sync)\s*\(\s*\{/g;

/** A string value counts as a placeholder (type-wildcard) when it carries doc
 *  placeholder markers rather than a concrete literal. */
function isPlaceholderText(inner: string): boolean {
  return inner.includes('<') || inner.includes('>') || inner === '...' || inner.trim() === '';
}

/**
 * Returns the index of the bracket that closes the bracket at `openIndex`, or -1.
 * It skips comments before it detects strings. Otherwise an apostrophe in a `//`
 * comment opens a false string and breaks the match for the rest of the document.
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
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
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
      while (i < body.length && body[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < body.length && !(body[i] === '*' && body[i + 1] === '/')) i++;
      i++;
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
 * Extracts each `exarchos_<tool>({ ... })` call example from a Markdown document.
 * It removes blockquote markers (`>`) at the start of body lines, because a marker
 * hides the param key. The scan continues after each call, so a nested call is not counted twice.
 */
export function extractToolExamples(markdown: string, file = '<memory>'): ToolExample[] {
  const examples: ToolExample[] = [];
  TOOL_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_RE.exec(markdown)) !== null) {
    const tool = `exarchos_${match[1]}`;
    const openBrace = markdown.indexOf('{', match.index);
    if (openBrace < 0) continue;
    const close = findMatchingClose(markdown, openBrace);
    if (close < 0) continue;
    const body = markdown.slice(openBrace + 1, close).replace(/^[ \t]*>+[ \t]?/gm, '');
    const params = parseParams(body);
    const actionVal = params['action'];
    let action: string | null = null;
    if (actionVal && (actionVal.kind === 'string' || actionVal.kind === 'placeholder')) {
      action = actionVal.text ?? null;
    }
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
    TOOL_CALL_RE.lastIndex = close + 1;
  }
  return examples;
}

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

/**
 * Validates one example against the oracle. A placeholder, an expression, or `null`
 * matches each type, because docs use `"<id>"` for each field. An enum property gets
 * a membership check. Otherwise a typed property gets a type check, then a range check.
 */
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

    if (value.kind === 'placeholder' || value.kind === 'expression' || value.kind === 'null') {
      continue;
    }

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

    if (prop.types.length === 0) continue;
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

/** Returns a message for the first bound that `num` violates, or `null` when it satisfies all bounds. */
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
