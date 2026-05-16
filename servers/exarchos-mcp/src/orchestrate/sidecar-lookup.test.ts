// ─── Sidecar Lookup — path-resolution tests (B1, #1406) ──────────────────────
//
// Anchors `sidecarPathFor`'s canonical convention: `<base>.sidecar.yml`
// next to the markdown, NOT `<base>.md.sidecar.yml`. The bug caught by
// CodeRabbit on PR #1406 was that the helper appended `.sidecar.yml` to
// the verbatim doc path, so for a `.md` input the sidecar lookup never
// resolved on disk and every gate silently fell back to regex.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';

import { sidecarPathFor } from './sidecar-lookup.js';

describe('SidecarPathFor', () => {
  it('MarkdownInput_StripsMdAndAppendsSidecarYml', () => {
    expect(sidecarPathFor('foo.md')).toBe('foo.sidecar.yml');
  });

  it('NonMarkdownInput_AppendsSidecarYml', () => {
    expect(sidecarPathFor('foo')).toBe('foo.sidecar.yml');
  });

  it('PathWithDirectories_StripsTrailingMdOnly', () => {
    expect(sidecarPathFor('docs/designs/2026-05-15-feature.md')).toBe(
      'docs/designs/2026-05-15-feature.sidecar.yml',
    );
  });

  it('NonMdExtension_IsPreservedVerbatim', () => {
    // Only a trailing `.md` is stripped; other extensions stay as-is.
    expect(sidecarPathFor('foo.markdown')).toBe('foo.markdown.sidecar.yml');
  });
});
