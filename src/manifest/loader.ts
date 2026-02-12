/**
 * Manifest loader and validation for the Exarchos installer.
 *
 * Reads a JSON manifest file from disk, validates its structure,
 * and returns a strongly-typed {@link Manifest} object.
 */

import * as fs from 'node:fs';
import type {
  Manifest,
  ManifestComponents,
  ManifestDefaults,
} from './types.js';

/**
 * User selections from the installation wizard.
 *
 * Captures which optional components the user chose to install
 * and their preferred model.
 */
export interface WizardSelections {
  /** IDs of selected MCP servers (excludes required servers). */
  readonly mcpServers: string[];
  /** IDs of selected plugins. */
  readonly plugins: string[];
  /** IDs of selected rule sets. */
  readonly ruleSets: string[];
  /** Selected Claude model identifier. */
  readonly model: string;
}

/**
 * Load and validate a manifest file from disk.
 *
 * @param filePath - Absolute or relative path to the manifest JSON file.
 * @returns A validated {@link Manifest} object.
 * @throws If the file does not exist, contains invalid JSON, or is missing required fields.
 */
export function loadManifest(filePath: string): Manifest {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Manifest file not found: ${filePath}`);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse manifest JSON at ${filePath}`);
  }

  return validateManifest(parsed);
}

/**
 * Extract the default wizard selections from a manifest.
 *
 * Returns the IDs of components marked as `default: true` and
 * the default model. Required servers are excluded — they are
 * always installed regardless of selection.
 *
 * @param manifest - A validated manifest.
 * @returns Default {@link WizardSelections}.
 */
export function getDefaultSelections(manifest: Manifest): WizardSelections {
  return {
    mcpServers: [], // Optional servers have no `default` flag; none selected by default
    plugins: manifest.components.plugins
      .filter((p) => p.default)
      .map((p) => p.id),
    ruleSets: manifest.components.ruleSets
      .filter((r) => r.default)
      .map((r) => r.id),
    model: manifest.defaults.model,
  };
}

/**
 * Extract the IDs of all required (always-installed) components.
 *
 * @param manifest - A validated manifest.
 * @returns An object with `servers` and `plugins` arrays of required IDs.
 */
export function getRequiredComponents(manifest: Manifest): {
  servers: string[];
  plugins: string[];
} {
  return {
    servers: manifest.components.mcpServers
      .filter((s) => s.required)
      .map((s) => s.id),
    plugins: manifest.components.plugins
      .filter((p) => p.required)
      .map((p) => p.id),
  };
}

// ─── Validation helpers ──────────────────────────────────────────────────────

/**
 * Validate that an unknown value conforms to the {@link Manifest} shape.
 *
 * @throws With a descriptive message identifying the first missing or invalid field.
 */
function validateManifest(value: unknown): Manifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Manifest must be a JSON object');
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj['version'] !== 'string' || obj['version'].length === 0) {
    throw new Error('Manifest is missing required field: version (must be a non-empty string)');
  }

  if (typeof obj['components'] !== 'object' || obj['components'] === null) {
    throw new Error('Manifest is missing required field: components (must be an object)');
  }

  if (typeof obj['defaults'] !== 'object' || obj['defaults'] === null) {
    throw new Error('Manifest is missing required field: defaults (must be an object)');
  }

  validateComponents(obj['components'] as Record<string, unknown>);
  validateDefaults(obj['defaults'] as Record<string, unknown>);

  return value as Manifest;
}

/** Validate the `components` section of a manifest. */
function validateComponents(components: Record<string, unknown>): void {
  const requiredArrays: Array<keyof ManifestComponents> = [
    'core',
    'mcpServers',
    'plugins',
    'ruleSets',
  ];

  for (const key of requiredArrays) {
    if (!Array.isArray(components[key])) {
      throw new Error(
        `Manifest components is missing required field: ${key} (must be an array)`,
      );
    }
  }
}

/** Validate the `defaults` section of a manifest. */
function validateDefaults(defaults: Record<string, unknown>): void {
  if (typeof defaults['model'] !== 'string' || defaults['model'].length === 0) {
    throw new Error(
      'Manifest defaults is missing required field: model (must be a non-empty string)',
    );
  }

  if (defaults['mode'] !== 'standard' && defaults['mode'] !== 'dev') {
    throw new Error(
      'Manifest defaults.mode must be "standard" or "dev"',
    );
  }
}
