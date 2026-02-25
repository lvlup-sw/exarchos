import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  SessionToolEvent,
  SessionTurnEvent,
  SessionSummaryEvent,
} from './types.js';

describe('Session Provenance Projection', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-test-'));
    await fs.mkdir(path.join(tmpDir, 'sessions'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  /** Write events to a session JSONL file */
  async function writeEventsFile(
    sessionId: string,
    events: Array<SessionToolEvent | SessionTurnEvent | SessionSummaryEvent>,
  ): Promise<void> {
    const eventsPath = path.join(tmpDir, 'sessions', `${sessionId}.events.jsonl`);
    const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(eventsPath, content, 'utf-8');
  }

  /** Write a manifest JSONL with entries */
  async function writeManifest(
    entries: Array<{ sessionId: string; workflowId?: string; transcriptPath: string; startedAt: string; cwd: string }>,
  ): Promise<void> {
    const manifestPath = path.join(tmpDir, 'sessions', '.manifest.jsonl');
    const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(manifestPath, content, 'utf-8');
  }

  describe('materializeSession — Tool Events', () => {
    it('materializeSession_ToolEvents_ReturnsToolBreakdownByCategory', async () => {
      // Arrange
      const events: SessionToolEvent[] = [
        { t: 'tool', ts: '2026-01-01T00:00:00Z', tool: 'Read', cat: 'native', inB: 100, outB: 200, sid: 'sess-1' },
        { t: 'tool', ts: '2026-01-01T00:01:00Z', tool: 'Write', cat: 'native', inB: 150, outB: 250, sid: 'sess-1' },
        { t: 'tool', ts: '2026-01-01T00:02:00Z', tool: 'exarchos_workflow', cat: 'mcp_exarchos', inB: 50, outB: 300, sid: 'sess-1' },
        { t: 'tool', ts: '2026-01-01T00:03:00Z', tool: 'github_search', cat: 'mcp_other', inB: 80, outB: 120, sid: 'sess-1' },
        { t: 'tool', ts: '2026-01-01T00:04:00Z', tool: 'github_issues', cat: 'mcp_other', inB: 90, outB: 110, sid: 'sess-1' },
      ];
      await writeEventsFile('sess-1', events);

      // Act
      const { materializeSessionProvenance } = await import('./session-provenance-projection.js');
      const result = await materializeSessionProvenance(tmpDir, { sessionId: 'sess-1' });

      // Assert
      expect(result.toolsByCategory).toEqual({
        native: 2,
        mcp_exarchos: 1,
        mcp_other: 2,
      });
      expect(result.tools).toEqual({
        Read: 1,
        Write: 1,
        exarchos_workflow: 1,
        github_search: 1,
        github_issues: 1,
      });
    });
  });

  describe('materializeSession — Turn Events', () => {
    it('materializeSession_TurnEvents_ReturnsTokenTotals', async () => {
      // Arrange
      const events: SessionTurnEvent[] = [
        { t: 'turn', ts: '2026-01-01T00:00:00Z', model: 'opus-4', tokIn: 1000, tokOut: 500, tokCacheR: 200, tokCacheW: 100, sid: 'sess-2' },
        { t: 'turn', ts: '2026-01-01T00:01:00Z', model: 'opus-4', tokIn: 800, tokOut: 300, tokCacheR: 150, tokCacheW: 80, sid: 'sess-2' },
        { t: 'turn', ts: '2026-01-01T00:02:00Z', model: 'opus-4', tokIn: 1200, tokOut: 600, tokCacheR: 250, tokCacheW: 120, sid: 'sess-2' },
      ];
      await writeEventsFile('sess-2', events);

      // Act
      const { materializeSessionProvenance } = await import('./session-provenance-projection.js');
      const result = await materializeSessionProvenance(tmpDir, { sessionId: 'sess-2' });

      // Assert
      expect(result.tokens).toEqual({
        in: 3000,
        out: 1400,
        cacheR: 600,
        cacheW: 300,
      });
    });
  });

  describe('materializeSession — Summary Event', () => {
    it('materializeSession_SummaryEvent_ReturnsSessionOverview', async () => {
      // Arrange
      const events: SessionSummaryEvent[] = [
        {
          t: 'summary',
          ts: '2026-01-01T01:00:00Z',
          sid: 'sess-3',
          tools: { Read: 5, Write: 3, exarchos_workflow: 2 },
          tokTotal: { in: 5000, out: 2000, cacheR: 1000, cacheW: 500 },
          files: ['src/auth.ts', 'src/login.ts'],
          dur: 3600,
          turns: 15,
        },
      ];
      await writeEventsFile('sess-3', events);

      // Act
      const { materializeSessionProvenance } = await import('./session-provenance-projection.js');
      const result = await materializeSessionProvenance(tmpDir, { sessionId: 'sess-3' });

      // Assert
      expect(result.duration).toBe(3600);
      expect(result.turns).toBe(15);
      expect(result.files).toEqual(['src/auth.ts', 'src/login.ts']);
      expect(result.tools).toEqual({ Read: 5, Write: 3, exarchos_workflow: 2 });
    });
  });

  describe('materializeWorkflow — Multiple Sessions', () => {
    it('materializeWorkflow_MultipleSessions_AggregatesAcrossSessions', async () => {
      // Arrange: two sessions linked to the same workflow
      await writeManifest([
        { sessionId: 'wf-sess-1', workflowId: 'wf-abc', transcriptPath: '/tmp/t1', startedAt: '2026-01-01T00:00:00Z', cwd: '/tmp' },
        { sessionId: 'wf-sess-2', workflowId: 'wf-abc', transcriptPath: '/tmp/t2', startedAt: '2026-01-01T01:00:00Z', cwd: '/tmp' },
        { sessionId: 'other-sess', workflowId: 'wf-other', transcriptPath: '/tmp/t3', startedAt: '2026-01-01T02:00:00Z', cwd: '/tmp' },
      ]);

      const sess1Events: Array<SessionToolEvent | SessionSummaryEvent> = [
        { t: 'tool', ts: '2026-01-01T00:00:00Z', tool: 'Read', cat: 'native', inB: 100, outB: 200, sid: 'wf-sess-1', wid: 'wf-abc' },
        {
          t: 'summary', ts: '2026-01-01T00:30:00Z', sid: 'wf-sess-1', wid: 'wf-abc',
          tools: { Read: 3 }, tokTotal: { in: 2000, out: 1000, cacheR: 500, cacheW: 200 },
          files: ['src/a.ts'], dur: 1800, turns: 5,
        },
      ];
      const sess2Events: Array<SessionToolEvent | SessionSummaryEvent> = [
        { t: 'tool', ts: '2026-01-01T01:00:00Z', tool: 'Write', cat: 'native', inB: 50, outB: 100, sid: 'wf-sess-2', wid: 'wf-abc' },
        {
          t: 'summary', ts: '2026-01-01T01:30:00Z', sid: 'wf-sess-2', wid: 'wf-abc',
          tools: { Write: 2 }, tokTotal: { in: 1500, out: 800, cacheR: 300, cacheW: 100 },
          files: ['src/b.ts'], dur: 1200, turns: 3,
        },
      ];

      await writeEventsFile('wf-sess-1', sess1Events);
      await writeEventsFile('wf-sess-2', sess2Events);

      // Act
      const { materializeSessionProvenance } = await import('./session-provenance-projection.js');
      const result = await materializeSessionProvenance(tmpDir, { workflowId: 'wf-abc' });

      // Assert
      expect(result.workflowId).toBe('wf-abc');
      expect(result.sessions).toBe(2);
      expect(result.tokens).toEqual({
        in: 3500,
        out: 1800,
        cacheR: 800,
        cacheW: 300,
      });
      expect(result.duration).toBe(3000); // 1800 + 1200
      expect(result.turns).toBe(8); // 5 + 3
      expect(result.files).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
      expect(result.tools).toEqual({ Read: 3, Write: 2 });
    });
  });

  describe('materializeMetric — Cost', () => {
    it('materializeMetric_Cost_ReturnsTokenTotalsBySession', async () => {
      // Arrange
      await writeManifest([
        { sessionId: 'cost-sess-1', workflowId: 'wf-cost', transcriptPath: '/tmp/t1', startedAt: '2026-01-01T00:00:00Z', cwd: '/tmp' },
        { sessionId: 'cost-sess-2', workflowId: 'wf-cost', transcriptPath: '/tmp/t2', startedAt: '2026-01-01T01:00:00Z', cwd: '/tmp' },
      ]);

      await writeEventsFile('cost-sess-1', [
        { t: 'turn', ts: '2026-01-01T00:00:00Z', model: 'opus-4', tokIn: 1000, tokOut: 500, tokCacheR: 200, tokCacheW: 100, sid: 'cost-sess-1', wid: 'wf-cost' },
        { t: 'turn', ts: '2026-01-01T00:01:00Z', model: 'opus-4', tokIn: 800, tokOut: 300, tokCacheR: 100, tokCacheW: 50, sid: 'cost-sess-1', wid: 'wf-cost' },
      ]);

      await writeEventsFile('cost-sess-2', [
        { t: 'turn', ts: '2026-01-01T01:00:00Z', model: 'opus-4', tokIn: 2000, tokOut: 1000, tokCacheR: 500, tokCacheW: 250, sid: 'cost-sess-2', wid: 'wf-cost' },
      ]);

      // Act
      const { materializeSessionProvenance } = await import('./session-provenance-projection.js');
      const result = await materializeSessionProvenance(tmpDir, { workflowId: 'wf-cost', metric: 'cost' });

      // Assert
      expect(result.costBySession).toHaveLength(2);
      const sess1 = result.costBySession!.find((s) => s.sid === 'cost-sess-1');
      expect(sess1).toBeDefined();
      expect(sess1!.tokens).toEqual({ in: 1800, out: 800 });
      const sess2 = result.costBySession!.find((s) => s.sid === 'cost-sess-2');
      expect(sess2).toBeDefined();
      expect(sess2!.tokens).toEqual({ in: 2000, out: 1000 });
    });
  });

  describe('materializeMetric — Attribution', () => {
    it('materializeMetric_Attribution_ReturnsFileToToolMapping', async () => {
      // Arrange
      const events: SessionToolEvent[] = [
        { t: 'tool', ts: '2026-01-01T00:00:00Z', tool: 'Read', cat: 'native', inB: 100, outB: 200, files: ['src/auth.ts', 'src/login.ts'], sid: 'attr-sess' },
        { t: 'tool', ts: '2026-01-01T00:01:00Z', tool: 'Write', cat: 'native', inB: 50, outB: 150, files: ['src/auth.ts'], sid: 'attr-sess' },
        { t: 'tool', ts: '2026-01-01T00:02:00Z', tool: 'Edit', cat: 'native', inB: 80, outB: 120, files: ['src/login.ts', 'src/config.ts'], sid: 'attr-sess' },
        { t: 'tool', ts: '2026-01-01T00:03:00Z', tool: 'Bash', cat: 'native', inB: 30, outB: 40, sid: 'attr-sess' }, // no files
      ];
      await writeEventsFile('attr-sess', events);

      // Act
      const { materializeSessionProvenance } = await import('./session-provenance-projection.js');
      const result = await materializeSessionProvenance(tmpDir, { sessionId: 'attr-sess', metric: 'attribution' });

      // Assert
      expect(result.fileAttribution).toBeDefined();
      const authEntry = result.fileAttribution!.find((f) => f.file === 'src/auth.ts');
      expect(authEntry).toBeDefined();
      expect(authEntry!.tools).toEqual(expect.arrayContaining(['Read', 'Write']));
      expect(authEntry!.tools).toHaveLength(2);

      const loginEntry = result.fileAttribution!.find((f) => f.file === 'src/login.ts');
      expect(loginEntry).toBeDefined();
      expect(loginEntry!.tools).toEqual(expect.arrayContaining(['Read', 'Edit']));

      const configEntry = result.fileAttribution!.find((f) => f.file === 'src/config.ts');
      expect(configEntry).toBeDefined();
      expect(configEntry!.tools).toEqual(['Edit']);
    });
  });

  describe('Edge cases', () => {
    it('materializeSession_EmptyEventsFile_ReturnsEmptyResult', async () => {
      // Arrange: empty events file
      const eventsPath = path.join(tmpDir, 'sessions', 'empty-sess.events.jsonl');
      await fs.writeFile(eventsPath, '', 'utf-8');

      // Act
      const { materializeSessionProvenance } = await import('./session-provenance-projection.js');
      const result = await materializeSessionProvenance(tmpDir, { sessionId: 'empty-sess' });

      // Assert
      expect(result.sessionId).toBe('empty-sess');
      expect(result.tools).toEqual({});
      expect(result.toolsByCategory).toEqual({ native: 0, mcp_exarchos: 0, mcp_other: 0 });
      expect(result.tokens).toEqual({ in: 0, out: 0, cacheR: 0, cacheW: 0 });
    });

    it('materializeSession_MissingEventsFile_ReturnsEmptyResult', async () => {
      // Act: no events file exists
      const { materializeSessionProvenance } = await import('./session-provenance-projection.js');
      const result = await materializeSessionProvenance(tmpDir, { sessionId: 'nonexistent' });

      // Assert
      expect(result.sessionId).toBe('nonexistent');
      expect(result.tools).toEqual({});
    });
  });
});
