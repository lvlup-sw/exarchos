import { describe, it, expect, vi } from 'vitest';
import { MetricsCollector } from './metrics.js';

describe('MetricsCollector', () => {
  it('MetricsCollector_RecordTokens_AggregatesCorrectly', () => {
    const collector = new MetricsCollector();
    collector.recordTokens(100, 50);
    collector.recordTokens(200, 150);

    const metrics = collector.toMetrics();
    expect(metrics.inputTokens).toBe(300);
    expect(metrics.outputTokens).toBe(200);
    expect(metrics.totalTokens).toBe(500);
  });

  it('MetricsCollector_RecordWallClock_CapturesDuration', () => {
    const collector = new MetricsCollector();

    // Mock performance.now to control timing
    const mockNow = vi.spyOn(performance, 'now');
    mockNow.mockReturnValueOnce(1000).mockReturnValueOnce(3500);

    collector.start();
    collector.stop();

    const metrics = collector.toMetrics();
    expect(metrics.wallClockSeconds).toBe(2.5);

    mockNow.mockRestore();
  });

  it('MetricsCollector_RecordIteration_IncrementsCount', () => {
    const collector = new MetricsCollector();
    collector.recordIteration();
    collector.recordIteration();
    collector.recordIteration();

    const metrics = collector.toMetrics();
    expect(metrics.iterationCount).toBe(3);
  });

  it('MetricsCollector_CountLinesOfCode_ReturnsAccurateCount', () => {
    const collector = new MetricsCollector();
    const code = [
      '#include <iostream>',
      '',
      '// Main function',
      'int main() {',
      '    // read input',
      '    int n;',
      '    std::cin >> n;',
      '',
      '    return 0;',
      '}',
    ].join('\n');

    const loc = collector.countLoc(code);
    // Excludes: 2 blank lines, 2 comment-only lines = 6 actual lines
    expect(loc).toBe(6);
  });

  it('MetricsCollector_ToMetrics_MapsAllFields', () => {
    const collector = new MetricsCollector();
    const mockNow = vi.spyOn(performance, 'now');
    mockNow.mockReturnValueOnce(0).mockReturnValueOnce(5000);

    collector.start();
    collector.recordTokens(50, 25);
    collector.recordIteration();
    collector.stop();

    const code = 'int main() {\n    return 0;\n}\n';
    const metrics = collector.toMetrics(code);

    expect(metrics.totalTokens).toBe(75);
    expect(metrics.inputTokens).toBe(50);
    expect(metrics.outputTokens).toBe(25);
    expect(metrics.wallClockSeconds).toBe(5);
    expect(metrics.iterationCount).toBe(1);
    expect(metrics.linesOfCode).toBe(3);

    mockNow.mockRestore();
  });

  it('MetricsCollector_EstimateTokens_DividesByFour', () => {
    expect(MetricsCollector.estimateTokens(400)).toBe(100);
    expect(MetricsCollector.estimateTokens(0)).toBe(0);
    expect(MetricsCollector.estimateTokens(7)).toBe(1); // rounds down via Math.floor
  });
});
