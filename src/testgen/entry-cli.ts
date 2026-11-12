import { runCli } from './adapters/cli.js';

process.exitCode = await runCli(
  process.argv.slice(2),
  (text) => process.stdout.write(text),
  (text) => process.stderr.write(text),
);
