import { createV2Server, parseV2ToolDefinition } from '../../contract/sdk/seam.js';
import { describeOperations, dispatch } from '../contract/operations.js';
import type { Emitter } from '../contract/operations.js';

export function createTestgenServer(emit?: Emitter) {
  const server = createV2Server({ name: 'testgen', version: '0.1.0' }, { capabilities: { tools: {} } });
  const tools = describeOperations().operations.map((tool) => parseV2ToolDefinition({
    ...tool,
    inputSchema: { ...tool.inputSchema, type: 'object' },
    outputSchema: { ...tool.outputSchema, type: 'object' },
  }));

  server.setRequestHandler('tools/list', () => ({ tools }));
  server.setRequestHandler('tools/call', ({ params }) => {
    const result = dispatch(params.name, params.arguments ?? {}, emit);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError: !result.ok,
    };
  });
  return server;
}
