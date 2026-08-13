import { describe, it, expect } from 'vitest';
import { extractOutputText } from './output-extractor.js';

describe('extractOutputText', () => {
  it('extractOutputText_NoPath_ReturnsStringifiedOutput', () => {
    const output = { foo: 'bar', count: 42 };
    const result = extractOutputText(output);
    expect(result).toBe(JSON.stringify(output));
  });

  it('extractOutputText_WithSimplePath_ReturnsFieldValue', () => {
    const output = { name: 'Alice', age: 30 };
    const result = extractOutputText(output, 'name');
    expect(result).toBe('Alice');
  });

  it('extractOutputText_WithDotPath_ReturnsNestedValue', () => {
    const output = { response: { text: 'Hello, world!' } };
    const result = extractOutputText(output, 'response.text');
    expect(result).toBe('Hello, world!');
  });

  it('extractOutputText_WithMissingPath_ReturnsNull', () => {
    const output = { foo: 'bar' };
    const result = extractOutputText(output, 'nonexistent');
    expect(result).toBeNull();
  });

  it('extractOutputText_WithArrayPath_ReturnsStringifiedArray', () => {
    const output = { tasks: ['T1', 'T2', 'T3'] };
    const result = extractOutputText(output, 'tasks');
    expect(result).toBe(JSON.stringify(['T1', 'T2', 'T3']));
  });

  it('extractOutputText_WithStringValue_ReturnsDirectly', () => {
    const output = { text: 'direct string' };
    const result = extractOutputText(output, 'text');
    expect(result).toBe('direct string');
  });
});
