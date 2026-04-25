/**
 * RED test — projections architecture doc references required shape (T062, DR-17).
 *
 * Asserts that `docs/architecture/projections.md` exists and contains the
 * structural markers required by the T062 design:
 *
 *   1. File exists.
 *   2. Contains 6 required section headings.
 *   3. Mentions the canonical symbols: `ProjectionReducer`, `defaultRegistry`,
 *      `buildDegradedResponse`, `rebuildProjection`.
 *   4. Has at least one fenced code block.
 *   5. Has a link to the design doc `docs/designs/2026-04-23-rehydrate-foundation.md`.
 *
 * Phase: RED → the doc does not yet exist.
 * GREEN: `docs/architecture/projections.md` is created with all required content.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'architecture', 'projections.md');

describe('ProjectionsArchDoc_ReferencesRequiredTestShape', () => {
  let content: string;

  it('Doc_Exists', () => {
    expect(fs.existsSync(DOC_PATH), `expected ${DOC_PATH} to exist`).toBe(true);
    content = fs.readFileSync(DOC_PATH, 'utf8');
  });

  it('Doc_ContainsReducerInterfaceSection', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    // Section 1: Reducer interface contract
    expect(content).toMatch(/reducer interface/i);
  });

  it('Doc_ContainsRequiredTestShapeSection', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    // Section 2: Required test shape
    expect(content).toMatch(/required test shape/i);
  });

  it('Doc_ContainsRegistrationProtocolSection', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    // Section 3: Registration protocol
    expect(content).toMatch(/registration protocol/i);
  });

  it('Doc_ContainsFailureModeSection', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    // Section 4: Failure-mode conventions
    expect(content).toMatch(/failure.mode/i);
  });

  it('Doc_ContainsSnapshotSection', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    // Section 5: Snapshot store + cadence
    expect(content).toMatch(/snapshot/i);
  });

  it('Doc_ContainsDesignDocLink', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    // Section 6: Link to design doc
    expect(content).toContain('docs/designs/2026-04-23-rehydrate-foundation.md');
  });

  it('Doc_MentionsProjectionReducer', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    expect(content).toContain('ProjectionReducer');
  });

  it('Doc_MentionsDefaultRegistry', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    expect(content).toContain('defaultRegistry');
  });

  it('Doc_MentionsBuildDegradedResponse', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    expect(content).toContain('buildDegradedResponse');
  });

  it('Doc_MentionsRebuildProjection', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    expect(content).toContain('rebuildProjection');
  });

  it('Doc_HasFencedCodeBlock', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    // At least one TypeScript fenced code block
    expect(content).toMatch(/```ts/);
  });
});
