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

  /** The `build:binary` script must not name a `plugins/exarchos` path, and the `build:bundle` alias must stay absent. */
  it('buildScripts_afterMove_referenceNewPath', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
    expect(pkg.scripts['build:binary']).toContain('build-binary');
    expect(pkg.scripts['build:binary']).not.toContain('plugins/exarchos');
    expect(pkg.scripts['build:bundle']).toBeUndefined();
  });

  /** The dev entry point is the build output of the product, not a path inside a workspace package. */
  it('manifest_afterMove_referencesNewDevEntryPoint', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf-8'));
    const exarchos = manifest.components.mcpServers.find((s: any) => s.id === 'exarchos');
    expect(exarchos.devEntryPoint).toBe('dist/index.js');
    expect(exarchos.devEntryPoint).not.toContain('plugins/exarchos');
  });
});
