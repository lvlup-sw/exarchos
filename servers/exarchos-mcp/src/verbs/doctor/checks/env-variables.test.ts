import { describe, it, expect } from 'vitest';
import { envVariables } from './env-variables.js';
import { makeStubProbes } from './__shared__/make-stub-probes.js';

const signal = new AbortController().signal;

describe('env-variables', () => {
  it('EnvVariables_AllExarchosEnvValid_ReturnsPass', async () => {
    const probes = makeStubProbes({
      env: {
        EXARCHOS_LOG_LEVEL: 'debug',
        EXARCHOS_PLUGIN_ROOT: '/opt/exarchos',
        PATH: '/usr/bin', // unrelated, ignored
      },
    });

    const result = await envVariables(probes, signal);

    expect(result.category).toBe('env');
    expect(result.name).toBe('variables');
    expect(result.status).toBe('Pass');
    expect(result.fix).toBeUndefined();
  });

  it('EnvVariables_UnknownExarchosEnvVar_ReturnsWarning', async () => {
    const probes = makeStubProbes({
      env: {
        EXARCHOS_LOG_LEVEL: 'info',
        EXARCHOS_FOO: 'bar',
      },
    });

    const result = await envVariables(probes, signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('EXARCHOS_FOO');
    expect(result.fix).toBe(
      'Remove unknown variable or check documentation for supported EXARCHOS_* vars',
    );
  });
});
