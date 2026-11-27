/**
 * Refuses a CLI call of a retired action. The binary calls it before it opens the state, reads configuration or builds the command tree.
 * A call names a tool group and an action, as `exarchos orch <action>` does, or the top-level verb of a retired action.
 * The refusal uses the code and the message of the row in the retired-action table.
 */
import { RETIRED_ACTIONS, TOOL_REGISTRY, retiredActionResult, type RetiredAction } from '../../registry.js';

/**
 * The retired row that a CLI argument vector names, or undefined.
 * The vector starts with the runtime path and the script path. The group is the tool alias or the tool name without its prefix.
 */
function retiredCliCallOf(argv: readonly string[]): RetiredAction | undefined {
  const [, , group, action] = argv;
  if (group === undefined) return undefined;
  return RETIRED_ACTIONS.find((entry) => {
    if (entry.topLevel !== undefined && group === entry.topLevel) return true;
    if (action === undefined || entry.action !== action) return false;
    const alias = TOOL_REGISTRY.find((tool) => tool.name === entry.tool)?.cli?.alias;
    return group === entry.tool.replace(/^exarchos_/, '') || group === alias;
  });
}

/**
 * Writes the refusal of a retired CLI call and sets the exit code. It returns false and writes nothing for any other call.
 * With `--json`, stdout carries the failure envelope, as for a dispatch failure. Otherwise stderr carries the error line.
 */
export async function refuseRetiredCliCall(argv: readonly string[]): Promise<boolean> {
  const entry = retiredCliCallOf(argv);
  if (entry === undefined) return false;
  const [{ toEnvelope }, { printError, toCliResult }, { exitCodeForResult }] = await Promise.all([
    import('../../format.js'),
    import('./cli-format.js'),
    import('../../contract/error-families.js'),
  ]);
  const result = retiredActionResult(entry);
  if (argv.includes('--json')) {
    toCliResult(toEnvelope(result), 'json');
  } else {
    printError(result.error);
  }
  process.exitCode = exitCodeForResult(result);
  return true;
}
