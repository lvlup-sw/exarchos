/**
 * Checks the shape of `docs/architecture/projections.md`. The doc must hold five
 * section topics, four canonical symbols and a fenced TypeScript block. Its link
 * to the rehydrate-foundation design doc must resolve on disk.
 *
 * The doc lives in the external documents repository. The suite skips when the
 * checkout does not hold the doc.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'architecture', 'projections.md');

describe.skipIf(!fs.existsSync(DOC_PATH))('ProjectionsArchDoc_ReferencesRequiredTestShape', () => {
  let content: string;

  it('Doc_Exists', () => {
    expect(fs.existsSync(DOC_PATH), `expected ${DOC_PATH} to exist`).toBe(true);
    content = fs.readFileSync(DOC_PATH, 'utf8');
  });

  it('Doc_ContainsReducerInterfaceSection', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    expect(content).toMatch(/reducer interface/i);
  });

  it('Doc_ContainsRequiredTestShapeSection', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    expect(content).toMatch(/required test shape/i);
  });

  it('Doc_ContainsRegistrationProtocolSection', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    expect(content).toMatch(/registration protocol/i);
  });

  it('Doc_ContainsFailureModeSection', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    expect(content).toMatch(/failure.mode/i);
  });

  it('Doc_ContainsSnapshotSection', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    expect(content).toMatch(/snapshot/i);
  });

  /**
   * A substring match passes when the design doc path is only display text and
   * the link URL dangles. So the test finds the link by basename and resolves its
   * URL from the doc directory or the repo root. The target file must exist on disk.
   */
  it('Doc_ContainsDesignDocLink_ThatResolvesOnDisk', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
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

  /** The doc must hold at least one fenced TypeScript block. */
  it('Doc_HasFencedCodeBlock', () => {
    content = fs.readFileSync(DOC_PATH, 'utf8');
    expect(content).toMatch(/```ts/);
  });
});
