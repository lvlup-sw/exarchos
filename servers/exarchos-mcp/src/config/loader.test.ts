import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from './loader.js';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-loader-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('LoadConfig_NoConfigFile_ReturnsEmptyObject', async () => {
    // Act
    const result = await loadConfig(tmpDir);

    // Assert
    expect(result).toEqual({});
  });

  it('LoadConfig_ValidJsConfig_ReturnsConfig', async () => {
    // Arrange
    const configContent = `
      export default {
        workflows: {
          deploy: {
            phases: ['build', 'test', 'deploy'],
            initialPhase: 'build',
            transitions: [
              { from: 'build', to: 'test', event: 'build_done' },
              { from: 'test', to: 'deploy', event: 'tests_pass' },
            ],
          },
        },
      };
    `;
    await fs.writeFile(path.join(tmpDir, 'exarchos.config.js'), configContent);

    // Act
    const result = await loadConfig(tmpDir);

    // Assert
    expect(result.workflows).toBeDefined();
    expect(result.workflows?.deploy.phases).toEqual(['build', 'test', 'deploy']);
    expect(result.workflows?.deploy.initialPhase).toBe('build');
  });

  it('LoadConfig_InvalidConfig_Throws', async () => {
    // Arrange — initialPhase not in phases
    const configContent = `
      export default {
        workflows: {
          deploy: {
            phases: ['build'],
            initialPhase: 'nonexistent',
            transitions: [],
          },
        },
      };
    `;
    await fs.writeFile(path.join(tmpDir, 'exarchos.config.js'), configContent);

    // Act & Assert
    await expect(loadConfig(tmpDir)).rejects.toThrow('Invalid exarchos config');
  });

  it('LoadConfig_BuiltinWorkflowName_Throws', async () => {
    // Arrange
    const configContent = `
      export default {
        workflows: {
          feature: {
            phases: ['a'],
            initialPhase: 'a',
            transitions: [],
          },
        },
      };
    `;
    await fs.writeFile(path.join(tmpDir, 'exarchos.config.js'), configContent);

    // Act & Assert
    await expect(loadConfig(tmpDir)).rejects.toThrow('built-in');
  });

  it('LoadConfig_PrefersTs_OverJs', async () => {
    // Arrange — both files exist, .ts should be found first
    const tsConfig = `
      export default {
        workflows: {
          'from-ts': {
            phases: ['alpha'],
            initialPhase: 'alpha',
            transitions: [],
          },
        },
      };
    `;
    const jsConfig = `
      export default {
        workflows: {
          'from-js': {
            phases: ['beta'],
            initialPhase: 'beta',
            transitions: [],
          },
        },
      };
    `;
    await fs.writeFile(path.join(tmpDir, 'exarchos.config.ts'), tsConfig);
    await fs.writeFile(path.join(tmpDir, 'exarchos.config.js'), jsConfig);

    // Act
    const result = await loadConfig(tmpDir);

    // Assert — .ts is first in search order
    expect(result.workflows?.['from-ts']).toBeDefined();
    expect(result.workflows?.['from-js']).toBeUndefined();
  });

  it('LoadConfig_EmptyDefaultExport_ReturnsEmpty', async () => {
    // Arrange
    const configContent = `export default {};`;
    await fs.writeFile(path.join(tmpDir, 'exarchos.config.js'), configContent);

    // Act
    const result = await loadConfig(tmpDir);

    // Assert
    expect(result).toEqual({});
  });

  it('LoadConfig_WithEvents_ParsesEventDefinitions', async () => {
    // Arrange
    const configContent = `
      export default {
        events: {
          'deploy.started': { source: 'model' },
          'deploy.finished': { source: 'hook' },
        },
      };
    `;
    await fs.writeFile(path.join(tmpDir, 'exarchos.config.js'), configContent);

    // Act
    const result = await loadConfig(tmpDir);

    // Assert
    expect(result.events).toBeDefined();
    expect(result.events?.['deploy.started']).toEqual({ source: 'model' });
    expect(result.events?.['deploy.finished']).toEqual({ source: 'hook' });
  });

  it('LoadConfig_WithInvalidEventSource_Fails', async () => {
    // Arrange
    const configContent = `
      export default {
        events: {
          'deploy.started': { source: 'invalid-source' },
        },
      };
    `;
    await fs.writeFile(path.join(tmpDir, 'exarchos.config.js'), configContent);

    // Act & Assert
    await expect(loadConfig(tmpDir)).rejects.toThrow('Invalid exarchos config');
  });

  it('LoadConfig_WithViews_ParsesViewDefinitions', async () => {
    // Arrange
    const configContent = `
      export default {
        views: {
          'my-metrics': {
            events: ['task.completed', 'task.failed'],
            handler: './views/my-metrics.js',
          },
        },
      };
    `;
    await fs.writeFile(path.join(tmpDir, 'exarchos.config.js'), configContent);

    // Act
    const result = await loadConfig(tmpDir);

    // Assert
    expect(result.views).toBeDefined();
    expect(result.views?.['my-metrics']).toBeDefined();
    expect(result.views?.['my-metrics'].events).toEqual(['task.completed', 'task.failed']);
    expect(result.views?.['my-metrics'].handler).toBe('./views/my-metrics.js');
  });

  it('LoadConfig_WithInvalidViews_Throws', async () => {
    // Arrange — missing required handler field
    const configContent = `
      export default {
        views: {
          'bad-view': {
            events: ['task.completed'],
          },
        },
      };
    `;
    await fs.writeFile(path.join(tmpDir, 'exarchos.config.js'), configContent);

    // Act & Assert
    await expect(loadConfig(tmpDir)).rejects.toThrow('Invalid exarchos config');
  });

  it('LoadConfig_WithTools_ParsesToolDefinitions', async () => {
    // Arrange
    const configContent = `
      export default {
        tools: {
          'exarchos_deploy': {
            description: 'Custom deployment tool',
            actions: [
              {
                name: 'trigger',
                description: 'Trigger a deployment',
                handler: './tools/deploy-trigger.js',
              },
              {
                name: 'status',
                description: 'Check deployment status',
                handler: './tools/deploy-status.js',
              },
            ],
          },
        },
      };
    `;
    await fs.writeFile(path.join(tmpDir, 'exarchos.config.js'), configContent);

    // Act
    const result = await loadConfig(tmpDir);

    // Assert
    expect(result.tools).toBeDefined();
    expect(result.tools?.['exarchos_deploy']).toBeDefined();
    expect(result.tools?.['exarchos_deploy'].description).toBe('Custom deployment tool');
    expect(result.tools?.['exarchos_deploy'].actions).toHaveLength(2);
    expect(result.tools?.['exarchos_deploy'].actions[0].name).toBe('trigger');
    expect(result.tools?.['exarchos_deploy'].actions[0].handler).toBe('./tools/deploy-trigger.js');
  });

  it('LoadConfig_WithInvalidTools_Throws', async () => {
    // Arrange — missing required description field
    const configContent = `
      export default {
        tools: {
          'bad-tool': {
            actions: [],
          },
        },
      };
    `;
    await fs.writeFile(path.join(tmpDir, 'exarchos.config.js'), configContent);

    // Act & Assert
    await expect(loadConfig(tmpDir)).rejects.toThrow('Invalid exarchos config');
  });
});
