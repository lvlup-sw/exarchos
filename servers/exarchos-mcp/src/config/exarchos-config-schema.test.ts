import { describe, it, expect } from 'vitest';
import { ExarchosConfigSchema } from './exarchos-config-schema.js';

describe('ExarchosConfigSchema', () => {
  it('schema_AllFieldsProvided_Validates', () => {
    const result = ExarchosConfigSchema.safeParse({
      test: 'bun test',
      typecheck: 'tsc --noEmit',
      install: 'bun install',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.test).toBe('bun test');
      expect(result.data.typecheck).toBe('tsc --noEmit');
      expect(result.data.install).toBe('bun install');
    }
  });

  it('schema_PartialFields_Validates_TestOnly', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 'bun test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.test).toBe('bun test');
      expect(result.data.typecheck).toBeUndefined();
      expect(result.data.install).toBeUndefined();
      expect(result.data.typecheck).not.toBeNull();
      expect(result.data.install).not.toBeNull();
    }
  });

  it('schema_PartialFields_Validates_TypecheckOnly', () => {
    const result = ExarchosConfigSchema.safeParse({ typecheck: 'tsc --noEmit' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.typecheck).toBe('tsc --noEmit');
      expect(result.data.test).toBeUndefined();
      expect(result.data.install).toBeUndefined();
      expect(result.data.test).not.toBeNull();
      expect(result.data.install).not.toBeNull();
    }
  });

  it('schema_EmptyObject_Validates', () => {
    const result = ExarchosConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.test).toBeUndefined();
      expect(result.data.typecheck).toBeUndefined();
      expect(result.data.install).toBeUndefined();
    }
  });

  it('schema_TestUnsafeChars_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 'rm -rf /; pytest' });
    expect(result.success).toBe(false);
  });

  it('schema_TestBackticks_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 'pytest `whoami`' });
    expect(result.success).toBe(false);
  });

  it('schema_TestDollarSign_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 'pytest $HOME' });
    expect(result.success).toBe(false);
  });

  it('schema_UnknownField_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 'pytest', extra: 'foo' });
    expect(result.success).toBe(false);
  });

  it('schema_TypeMismatchedField_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 42 });
    expect(result.success).toBe(false);
  });

  it('schema_EmptyStringTest_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({ test: '' });
    expect(result.success).toBe(false);
  });
});
