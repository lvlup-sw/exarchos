import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseStdinJson, outputJson, routeCommand } from './cli.js';

describe('CLI Framework', () => {
  describe('parseStdinJson', () => {
    it('should parse valid JSON string into an object', () => {
      // Arrange
      const input = '{"tool_name": "exarchos_workflow", "action": "init"}';

      // Act
      const result = parseStdinJson(input);

      // Assert
      expect(result).toEqual({ tool_name: 'exarchos_workflow', action: 'init' });
    });

    it('should return empty object for empty string input', () => {
      // Arrange
      const input = '';

      // Act
      const result = parseStdinJson(input);

      // Assert
      expect(result).toEqual({});
    });

    it('should return empty object for whitespace-only input', () => {
      // Arrange
      const input = '   \n\t  ';

      // Act
      const result = parseStdinJson(input);

      // Assert
      expect(result).toEqual({});
    });

    it('should throw for invalid JSON', () => {
      // Arrange
      const input = '{ not valid json }';

      // Act & Assert
      expect(() => parseStdinJson(input)).toThrow();
    });

    it('should handle nested JSON objects', () => {
      // Arrange
      const input = JSON.stringify({
        tool_name: 'exarchos_orchestrate',
        tool_input: { action: 'task_claim', taskId: 'T1' },
      });

      // Act
      const result = parseStdinJson(input);

      // Assert
      expect(result).toEqual({
        tool_name: 'exarchos_orchestrate',
        tool_input: { action: 'task_claim', taskId: 'T1' },
      });
    });
  });

  describe('outputJson', () => {
    let writtenData: string;

    beforeEach(() => {
      writtenData = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        writtenData += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        return true;
      });
    });

    it('should write valid JSON to stdout', () => {
      // Arrange
      const obj = { success: true, data: 'test' };

      // Act
      outputJson(obj);

      // Assert
      const parsed = JSON.parse(writtenData);
      expect(parsed).toEqual({ success: true, data: 'test' });
    });

    it('should write a trailing newline', () => {
      // Arrange
      const obj = { ok: true };

      // Act
      outputJson(obj);

      // Assert
      expect(writtenData.endsWith('\n')).toBe(true);
    });

    it('should handle null value', () => {
      // Act
      outputJson(null);

      // Assert
      expect(JSON.parse(writtenData)).toBeNull();
    });

    it('should handle array value', () => {
      // Arrange
      const arr = [1, 2, 3];

      // Act
      outputJson(arr);

      // Assert
      expect(JSON.parse(writtenData)).toEqual([1, 2, 3]);
    });
  });

  describe('routeCommand', () => {
    it('should route pre-compact command to handler', async () => {
      // Act
      const result = await routeCommand('pre-compact', {});

      // Assert
      expect(result).toBeDefined();
      expect(result).toHaveProperty('error');
    });

    it('should route session-start command to handler', async () => {
      // Act
      const result = await routeCommand('session-start', {});

      // Assert — session-start is implemented; returns silently when no workflows found
      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it('should route guard command to handler', async () => {
      // Act — empty stdin data means no tool_name, so guard allows
      const result = await routeCommand('guard', {});

      // Assert — guard returns empty object (allow) for missing tool_name
      expect(result).toBeDefined();
      expect(result).toEqual({});
    });

    it('should route task-gate command to handler', async () => {
      // Act
      const result = await routeCommand('task-gate', {});

      // Assert
      expect(result).toBeDefined();
      expect(result).toHaveProperty('error');
    });

    it('should route teammate-gate command to handler', async () => {
      // Act
      const result = await routeCommand('teammate-gate', {});

      // Assert
      expect(result).toBeDefined();
      expect(result).toHaveProperty('error');
    });

    it('should route subagent-context command to real handler', async () => {
      // Act
      const result = await routeCommand('subagent-context', {});

      // Assert — real handler returns guidance (not an error)
      expect(result).toBeDefined();
      expect(result).toHaveProperty('guidance');
    });

    it('should return error for unknown command', async () => {
      // Act
      const result = await routeCommand('nonexistent', {});

      // Assert
      expect(result).toEqual({
        error: {
          code: 'UNKNOWN_COMMAND',
          message: 'Unknown command: nonexistent',
        },
      });
    });

    it('should pass stdin data to command handlers', async () => {
      // Arrange — tool_name without mcp__exarchos__ prefix, so guard allows
      const stdinData = { tool_name: 'exarchos_workflow', tool_input: { action: 'init' } };

      // Act
      const result = await routeCommand('guard', stdinData);

      // Assert — guard allows (not an exarchos MCP tool name)
      expect(result).toBeDefined();
    });

    it('should return not-implemented error for stubbed commands', async () => {
      // Act
      const result = await routeCommand('pre-compact', {});

      // Assert
      expect(result).toEqual({
        error: {
          code: 'NOT_IMPLEMENTED',
          message: 'pre-compact handler not yet implemented',
        },
      });
    });
  });
});
