import { connectV2Server, createV2StdioServerTransport } from '../contract/sdk/seam.js';
import { createTestgenServer } from './adapters/mcp.js';

await connectV2Server(createTestgenServer(), createV2StdioServerTransport());
