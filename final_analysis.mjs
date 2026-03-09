import * as registry from './servers/exarchos-mcp/dist/registry.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

console.log('=== TOKEN COST ANALYSIS: EXARCHOS MCP REGISTRATIONS ===\n');

// 1. Count all actions
let totalActions = 0;
const actionBreakdown = {};
for (const tool of registry.TOOL_REGISTRY) {
  const count = tool.actions.length;
  actionBreakdown[tool.name] = count;
  totalActions += count;
  if (!tool.hidden) console.log(`${tool.name}: ${count} actions`);
}
console.log(`Total: ${totalActions} actions (${totalActions - 1} in 4 visible tools, 1 hidden)\n`);

// 2. Calculate response payload overhead
console.log('=== RESPONSE PAYLOAD OVERHEAD ===\n');

// Sample perf metrics
const perfMetrics = JSON.stringify({ ms: 123, bytes: 5432, tokens: 1358 });
console.log(`_perf field: ${perfMetrics.length} bytes (~${Math.ceil(perfMetrics.length/4)} tokens)`);

// Sample corrections (typical: 1-3 applied)
const correction = JSON.stringify({ 
  applied: [{ param: 'limit', value: 50, rule: 'event-query-limit' }] 
});
console.log(`_corrections field (1 item): ${correction.length} bytes (~${Math.ceil(correction.length/4)} tokens)`);

// Sample event hints (typical: 2-5 missing events)
const eventHints = JSON.stringify({
  missing: [
    { eventType: 'task.created', description: 'Task created event missing' },
    { eventType: 'task.assigned', description: 'Task assigned event missing' }
  ],
  phase: 'delegate',
  checked: 15
});
console.log(`_eventHints field (2 items): ${eventHints.length} bytes (~${Math.ceil(eventHints.length/4)} tokens)`);
console.log(`Total overhead per response: ${perfMetrics.length + correction.length + eventHints.length} bytes max (~${Math.ceil((perfMetrics.length + correction.length + eventHints.length)/4)} tokens)`);
console.log('(Typically injected only when conditions are met; not always present)\n');

// 3. Tool descriptions
console.log('=== TOOL DESCRIPTIONS ===\n');
let totalDescSize = 0;
for (const tool of registry.TOOL_REGISTRY) {
  if (tool.hidden) continue;
  const desc = registry.buildToolDescription(tool);
  totalDescSize += desc.length;
  console.log(`${tool.name}: ${desc.length} bytes`);
}
console.log(`Total: ${totalDescSize} bytes\n`);

// 4. Registration schemas
console.log('=== REGISTRATION SCHEMAS ===\n');
let totalSchemaSize = 0;
for (const tool of registry.TOOL_REGISTRY) {
  if (tool.hidden) continue;
  const schema = registry.buildRegistrationSchema(tool.actions);
  const jsonSchema = zodToJsonSchema(schema);
  const schemaJson = JSON.stringify(jsonSchema);
  totalSchemaSize += schemaJson.length;
  const actionEnum = jsonSchema.properties.action;
  const enumSize = JSON.stringify(actionEnum).length;
  console.log(`${tool.name}: ${schemaJson.length} bytes (action enum: ${enumSize} bytes)`);
}
console.log(`Total: ${totalSchemaSize} bytes\n`);

// 5. Summary
console.log('=== TOKEN COST SUMMARY ===\n');
const totalRegBytes = totalSchemaSize + totalDescSize;
const totalRegTokens = Math.ceil(totalRegBytes / 4);
console.log(`Initial Registration (schemas + descriptions):`);
console.log(`  Bytes: ${totalRegBytes}`);
console.log(`  Tokens: ~${totalRegTokens} tokens`);
console.log(`\nPer Response Overhead:`);
console.log(`  Baseline: 3 required fields (success, data, error) = ~50-100 bytes`);
console.log(`  + _perf (26 bytes) + _corrections (varies) + _eventHints (varies)`);
console.log(`  Typical: 50-300 bytes per response overhead`);
console.log(`\nLargest Tool: exarchos_orchestrate`);
console.log(`  22 actions, 2960 byte schema, 3750 byte description`);
