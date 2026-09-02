import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '../../..');

describe('Server source paths', () => {
  it('serverSourcePath_afterMove_resolvesCorrectly', () => {
    expect(existsSync(join(repoRoot, 'src/index.ts'))).toBe(true);
  });

  it('oldServerPath_afterMove_doesNotExist', () => {
    expect(existsSync(join(repoRoot, 'plugins/exarchos/servers'))).toBe(false);
  });

  it('buildScripts_afterMove_referenceNewPath', () => {
    // Post-task-3.6 the legacy `build:bundle` alias (and its `build-bundle.ts`
    // script) are gone; `build:binary` is the replacement that invokes
    // `tools/release/build-binary.ts` against the same entry point
    // (`src/index.ts`). The original intent of this
    // assertion — guarding against any resurfaced `plugins/exarchos`
    // path — is preserved by pointing at `build:binary` instead.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
    expect(pkg.scripts['build:binary']).toContain('build-binary');
    expect(pkg.scripts['build:binary']).not.toContain('plugins/exarchos');
    // Hard negative: ensure the removed legacy alias is not re-introduced.
    expect(pkg.scripts['build:bundle']).toBeUndefined();
  });

  it('manifest_afterMove_referencesNewDevEntryPoint', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf-8'));
    const exarchos = manifest.components.mcpServers.find((s: any) => s.id === 'exarchos');
    // Task 019 dissolved the nested server package: the dev entry point is the
    // product's own build output, not a path inside a workspace.
    expect(exarchos.devEntryPoint).toBe('dist/index.js');
    expect(exarchos.devEntryPoint).not.toContain('plugins/exarchos');
  });
});
