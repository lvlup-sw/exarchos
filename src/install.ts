#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export async function buildMcpServer(serverPath: string): Promise<void> {
  if (!existsSync(serverPath)) {
    throw new Error(`MCP server path does not exist: ${serverPath}`);
  }

  console.log(`  Building MCP server at ${serverPath}...`);

  execSync('npm install --silent', {
    cwd: serverPath,
    stdio: 'inherit'
  });

  execSync('npm run build --silent', {
    cwd: serverPath,
    stdio: 'inherit'
  });

  console.log(`  [done] Built ${serverPath}`);
}

// Installer implementation - to be completed in subsequent tasks
console.log('lvlup-claude installer');
