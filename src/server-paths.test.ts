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
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
    expect(pkg.scripts['build:mcp']).toContain('servers/exarchos-mcp/src/index.ts');
    expect(pkg.scripts['build:mcp']).not.toContain('plugins/exarchos');
    expect(pkg.scripts['build:cli']).toContain('build-cli');
    expect(pkg.scripts['build:cli']).not.toContain('plugins/exarchos');
  });

  it('manifest_afterMove_referencesNewDevEntryPoint', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf-8'));
    const exarchos = manifest.components.mcpServers.find((s: any) => s.id === 'exarchos');
    expect(exarchos.devEntryPoint).toContain('servers/exarchos-mcp/');
    expect(exarchos.devEntryPoint).not.toContain('plugins/exarchos');
  });
});
