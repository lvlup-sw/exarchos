import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { installBundle } from './bundle.js';

describe('MCP Server Bundle Copy (C4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-bundle-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a fake bundle source file with given content. */
  function createSourceBundle(filename: string, content: string): string {
    const sourcePath = path.join(tmpDir, 'source', filename);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, content, 'utf-8');
    return sourcePath;
  }

  describe('installBundle', () => {
    it('installBundle_SourceExists_CopiesToMcpServersDir', () => {
      const bundleContent = 'console.log("mcp server bundle");';
      const sourcePath = createSourceBundle('exarchos-mcp.js', bundleContent);
      const claudeHome = path.join(tmpDir, '.claude');

      const result = installBundle(sourcePath, claudeHome);

      const expectedPath = path.join(claudeHome, 'mcp-servers', 'exarchos-mcp.js');
      expect(result.installedPath).toBe(expectedPath);
      expect(fs.existsSync(expectedPath)).toBe(true);
      expect(fs.readFileSync(expectedPath, 'utf-8')).toBe(bundleContent);
    });

    it('installBundle_MissingMcpDir_CreatesDir', () => {
      const sourcePath = createSourceBundle('server.js', 'content');
      const claudeHome = path.join(tmpDir, 'fresh-claude-home');
      const mcpDir = path.join(claudeHome, 'mcp-servers');

      // Verify the directory does not exist yet
      expect(fs.existsSync(mcpDir)).toBe(false);

      installBundle(sourcePath, claudeHome);

      // Directory should have been created
      expect(fs.existsSync(mcpDir)).toBe(true);
    });

    it('installBundle_ExistingBundle_Overwrites', () => {
      const claudeHome = path.join(tmpDir, '.claude');
      const mcpDir = path.join(claudeHome, 'mcp-servers');
      fs.mkdirSync(mcpDir, { recursive: true });

      // Write an existing (old) bundle
      const existingPath = path.join(mcpDir, 'server.js');
      fs.writeFileSync(existingPath, 'old content', 'utf-8');

      // Create new source
      const sourcePath = createSourceBundle('server.js', 'new content');

      installBundle(sourcePath, claudeHome);

      // Should be overwritten with new content
      expect(fs.readFileSync(existingPath, 'utf-8')).toBe('new content');
    });

    it('installBundle_MissingSource_ThrowsError', () => {
      const claudeHome = path.join(tmpDir, '.claude');
      const badSourcePath = path.join(tmpDir, 'nonexistent', 'server.js');

      expect(() => installBundle(badSourcePath, claudeHome)).toThrow(
        /not found|does not exist|ENOENT/i,
      );
    });

    it('installBundle_ReturnsFileSize_InBytes', () => {
      const content = 'A'.repeat(1024); // Exactly 1024 bytes
      const sourcePath = createSourceBundle('sized-server.js', content);
      const claudeHome = path.join(tmpDir, '.claude');

      const result = installBundle(sourcePath, claudeHome);

      expect(result.sizeBytes).toBe(1024);
    });
  });
});
