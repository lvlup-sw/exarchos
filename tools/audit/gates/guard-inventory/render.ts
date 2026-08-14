import { type GuardHost, type GuardInventory, isEnforcingHost } from './model.js';

export function describeHost(host: GuardHost): string {
  const chain = host.through.length === 0 ? '' : ` → ${host.through.join(' → ')}`;
  return `${host.job}${chain}${host.via === 'self-test' ? ' (via self-test)' : ''}`;
}

export function renderInventoryTable(inventory: GuardInventory): string {
  const rows = [
    '| Guard | CI job(s) | Path-filtered? | Blocks / observes | Prod caller? |',
    '|---|---|---|---|---|',
  ];
  for (const guard of inventory.guards) {
    const enforcing = guard.hosts.filter((h) => isEnforcingHost(h, guard.runnable));
    const jobs =
      enforcing.length === 0
        ? guard.hosts.length === 0
          ? '— (none)'
          : `— (self-test only: ${[...new Set(guard.hosts.map((h) => h.job))].join(', ')})`
        : [...new Set(enforcing.map((h) => describeHost(h)))].join(', ');
    const filtered =
      enforcing.length === 0
        ? '—'
        : guard.pathFilteredOnly
          ? `YES (${[...new Set(enforcing.flatMap((h) => [...h.pathFilterKeys]))].join('+')})`
          : 'no';
    const prod = guard.productionImported === null ? 'n/a' : guard.productionImported ? 'yes' : 'NO (R-11)';
    rows.push(`| \`${guard.artifact}\` | ${jobs} | ${filtered} | ${guard.enforcement} | ${prod} |`);
  }
  return rows.join('\n');
}
