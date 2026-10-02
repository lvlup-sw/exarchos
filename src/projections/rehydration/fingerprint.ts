import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from '../../utils/json-schema.js';

import { TOOL_REGISTRY, buildToolDescription } from '../../registry.js';
import { StableSectionsSchema } from './schema.js';

/**
 * Load the committed prefix fingerprint: the trimmed contents of the
 * `PREFIX_FINGERPRINT` file next to this module.
 *
 * The file holds the SHA-256 hex digest from {@link computePrefixFingerprint}.
 * CI computes the digest again and fails on a difference. An intended change
 * commits the new hash together with the template change.
 */
export function loadPrefixFingerprint(): string {
  const fingerprintUrl = new URL('./PREFIX_FINGERPRINT', import.meta.url);
  const contents = readFileSync(fileURLToPath(fingerprintUrl), 'utf8');
  return contents.replace(/\s+$/u, '');
}

/**
 * Overrides for {@link computePrefixFingerprint}. Tests use them to cause a
 * difference without a change to the real schema or registry.
 */
export interface PrefixFingerprintInputs {
  /** Canonical JSON-schema bytes for the stable sections. Defaults to the bytes of `StableSectionsSchema`. */
  schemaJson?: string;
  /**
   * The MCP tool-description bytes that a consuming agent sees. Defaults to the
   * non-slim {@link buildToolDescription} output for `exarchos_workflow`.
   */
  toolDescriptionBytes?: string;
}

const WORKFLOW_TOOL_NAME = 'exarchos_workflow';

/**
 * Serialize a JSON-safe value with the keys sorted at every object level. The
 * output does not depend on insertion order, so CI can reproduce the hash.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => stableStringify(item));
    return `[${parts.join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${parts.join(',')}}`;
}

/**
 * Default canonical JSON-schema bytes for `StableSectionsSchema`.
 *
 * {@link stableStringify} fixes the nested key order, so the emit order of the
 * converter cannot change the hash. The target is draft-07, so the fingerprint
 * stays stable when the default draft of the codebase changes.
 */
function defaultSchemaJson(): string {
  const schema = zodToJsonSchema(StableSectionsSchema, {
    target: 'draft-07',
  });
  return stableStringify(schema);
}

/**
 * Default tool-description bytes: the non-slim description of the workflow tool,
 * with the signature and description of each action. An edit to one of these
 * action descriptions changes the fingerprint. The scope is wider than the
 * `rehydrate` action on purpose, because the document prefix gives guidance for
 * the full tool surface.
 */
function defaultToolDescriptionBytes(): string {
  const tool = TOOL_REGISTRY.find((t) => t.name === WORKFLOW_TOOL_NAME);
  if (!tool) {
    throw new Error(
      `prefix-fingerprint: workflow tool '${WORKFLOW_TOOL_NAME}' not found in registry`,
    );
  }
  return buildToolDescription(tool, false);
}

/**
 * Compute the SHA-256 fingerprint of the stable prefix inputs of the rehydration
 * document, as a 64-character lowercase hex digest.
 *
 * The hash covers, in this order and separated by `\n--\n`:
 *   1. The canonical JSON schema of `StableSectionsSchema`.
 *   2. The non-slim MCP tool description for `exarchos_workflow`.
 *
 * The prompt cache becomes invalid when the bytes at the top of the document
 * change. A schema change and a tool description edit both change those bytes,
 * so CI fails fast on either.
 */
export function computePrefixFingerprint(inputs: PrefixFingerprintInputs = {}): string {
  const schemaJson = inputs.schemaJson ?? defaultSchemaJson();
  const toolDescriptionBytes = inputs.toolDescriptionBytes ?? defaultToolDescriptionBytes();

  const hash = createHash('sha256');
  hash.update('schema:', 'utf8');
  hash.update(schemaJson, 'utf8');
  hash.update('\n--\n', 'utf8');
  hash.update('toolDescription:', 'utf8');
  hash.update(toolDescriptionBytes, 'utf8');
  return hash.digest('hex');
}
