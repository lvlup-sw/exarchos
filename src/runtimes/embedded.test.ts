/**
 * Tests for the embedded-runtime loader.
 *
 * The compiled `exarchos` binary has no on-disk `runtimes/*.yaml` at
 * user-install time. `loadEmbeddedRuntimes()` returns the same maps the
 * disk-based `loadAllRuntimes()` produces, sourced from a build-time
 * codegen module so the runtime data is bundled into the binary.
 *
 * Implements: DR-7 (install-skills CLI), task 1.2 of the v2.9.0 closeout
 * (#1201).
 */

import { describe, it, expect } from 'vitest';
import { loadEmbeddedRuntimes } from './embedded.js';
import { REQUIRED_RUNTIME_NAMES } from './load.js';

describe('loadEmbeddedRuntimes', () => {
  it('loadEmbeddedRuntimes_AllSupportedRuntimes_ReturnsRuntimeMaps', () => {
    const runtimes = loadEmbeddedRuntimes();

    // Returns an object keyed by runtime name covering every required runtime.
    for (const name of REQUIRED_RUNTIME_NAMES) {
      expect(runtimes[name]).toBeDefined();
      expect(runtimes[name]).toMatchObject({ name });
      // Each entry is a non-empty object with a populated `name` field
      // (the canonical signal that a RuntimeMap parsed successfully).
      expect(typeof runtimes[name]).toBe('object');
      expect(Object.keys(runtimes[name]).length).toBeGreaterThan(0);
    }
  });
});
