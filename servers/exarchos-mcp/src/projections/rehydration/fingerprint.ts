import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { TOOL_REGISTRY, buildToolDescription } from '../../registry.js';
import { StableSectionsSchema } from './schema.js';

/**
 * Loads the committed prefix fingerprint for the rehydration projection.
 *
 * Reads the co-located `PREFIX_FINGERPRINT` file (written relative to this
 * module via `import.meta.url`) and returns its trimmed contents as a string.
 *
 * After T046, this file holds the SHA-256 hex digest produced by
 * {@link computePrefixFingerprint}. CI (T047) reruns the computation and
 * fails on divergence — intentional updates commit the new hash alongside
 * the template change that caused it.
 */
export function loadPrefixFingerprint(): string {
  const fingerprintUrl = new URL('./PREFIX_FINGERPRINT', import.meta.url);
  const contents = readFileSync(fileURLToPath(fingerprintUrl), 'utf8');
  return contents.replace(/\s+$/u, '');
}

/**
 * Optional overrides for {@link computePrefixFingerprint}. Tests inject
 * alternate byte strings via these keys to exercise divergence without
 * mutating the real schema or MCP registry.
 */
export interface PrefixFingerprintInputs {
  /**
   * Canonical JSON-schema bytes for the stable sections. Defaults to
   * `JSON.stringify(zodToJsonSchema(StableSectionsSchema), sortedKeys)`.
   */
  schemaJson?: string;
  /**
   * The MCP tool-description bytes seen by a consuming agent. Defaults to
   * the concatenation (joined by `\n---\n`) of the `exarchos_workflow` tool
   * description and every action description (including `rehydrate`), as
   * produced by {@link buildToolDescription} in non-slim mode.
   */
  toolDescriptionBytes?: string;
}

const WORKFLOW_TOOL_NAME = 'exarchos_workflow';

/**
 * Stable stringify: serialize an arbitrary JSON-safe value with keys sorted
 * at every nested object level. The output is byte-deterministic regardless
 * of insertion order in the source object — necessary for a hash that CI
 * can reproduce across machines and Node versions.
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
 * Default canonical JSON-schema bytes for `StableSectionsSchema`. Derived
 * via `zod-to-json-schema` then canonicalized through {@link stableStringify}
 * so nested key order is fixed — otherwise `zod-to-json-schema` internal
 * emit order could flip the hash between point releases.
 */
function defaultSchemaJson(): string {
  const schema = zodToJsonSchema(StableSectionsSchema, {
    name: 'StableSections',
    target: 'jsonSchema7',
  });
  return stableStringify(schema);
}

/**
 * Default tool-description bytes. We hash the non-slim description of the
 * workflow tool (which includes every action's signature + doc string) so
 * any edit to the workflow, rehydrate, checkpoint, etc. action descriptions
 * surfaces as a fingerprint divergence. This is a superset of the rehydrate
 * action alone, which is deliberate: the rehydration document's prefix
 * promises cover behavioral guidance that spans the full tool surface.
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
 * Compute the SHA-256 fingerprint of the rehydration document's stable
 * prefix inputs (DR-12).
 *
 * Inputs included in the hash (in this order, separated by `\n--\n`):
 *   1. Canonical JSON schema of `StableSectionsSchema` (stable-key
 *      stringified).
 *   2. Non-slim MCP tool description for `exarchos_workflow`, which
 *      includes every action's signature + description.
 *
 * The result is a 64-char lowercase hex digest. Tests may inject
 * {@link PrefixFingerprintInputs} overrides to exercise divergence without
 * mutating the real schema or registry.
 *
 * Rationale: the prompt cache invalidates any time the bytes agents see at
 * the top of the rehydration document change. Schema shape and tool
 * description are the two "invisible" drivers of those bytes — a schema
 * field rename flips serializer output; a tool description edit changes
 * what the agent reads. Hashing both lets CI fail fast on either.
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
