import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');

describe('Server source paths', () => {
  it('serverSourcePath_afterMove_resolvesCorrectly', () => {
    expect(existsSync(join(repoRoot, 'servers/exarchos-mcp/src/index.ts'))).toBe(true);
  });

  it('oldServerPath_afterMove_doesNotExist', () => {
    expect(existsSync(join(repoRoot, 'plugins/exarchos/servers'))).toBe(false);
  });

  it('buildScripts_afterMove_referenceNewPath', () => {
    // Post-task-3.6 the legacy `build:bundle` alias (and its `build-bundle.ts`
    // script) are gone; `build:binary` is the replacement that invokes
    // `scripts/build-binary.ts` against the same entry point
    // (`servers/exarchos-mcp/src/index.ts`). The original intent of this
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
    expect(exarchos.devEntryPoint).toContain('servers/exarchos-mcp/');
    expect(exarchos.devEntryPoint).not.toContain('plugins/exarchos');
  });
});
