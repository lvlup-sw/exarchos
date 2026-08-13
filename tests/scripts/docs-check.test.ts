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
 *   5. Has a markdown link to the rehydrate-foundation design doc whose URL
 *      RESOLVES to a file on disk (survives the DR-18 archive move).
 *
 * Phase: RED → the doc does not yet exist.
 * GREEN: `docs/architecture/projections.md` is created with all required content.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
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

  it('Doc_ContainsDesignDocLink_ThatResolvesOnDisk', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    // Section 6: Link to the rehydrate-foundation design doc.
    // Harden beyond a substring match. The previous `toContain(...)` assertion
    // stayed GREEN after the design doc was archived (DR-18) even though the
    // link URL dangled, because the pre-archive path still appeared as display
    // text. Instead, find the markdown link that targets the design doc by
    // basename, resolve its URL relative to this doc, and assert the target
    // FILE EXISTS on disk — so a future broken/moved link FAILS this test.
    const DESIGN_BASENAME = '2026-04-23-rehydrate-foundation.md';
    const linkUrls: string[] = [];
    for (const m of content.matchAll(/\]\(([^)]+)\)/g)) {
      const url = m[1];
      if (url !== undefined) linkUrls.push(url.trim());
    }
    const designLink = linkUrls.find(
      (t) => path.basename(t.split('#')[0] ?? '') === DESIGN_BASENAME,
    );
    expect(
      designLink,
      `expected a markdown link to the ${DESIGN_BASENAME} design doc`,
    ).toBeDefined();
    const urlPath = (designLink ?? '').split('#')[0] ?? '';
    const resolved = urlPath.startsWith('/')
      ? path.join(REPO_ROOT, urlPath.slice(1))
      : path.resolve(path.dirname(DOC_PATH), urlPath);
    expect(
      fs.existsSync(resolved),
      `design doc link "${designLink}" resolves to ${resolved}, which does not exist on disk`,
    ).toBe(true);
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
