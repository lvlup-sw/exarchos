import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Loads the committed prefix fingerprint for the rehydration projection.
 *
 * Reads the co-located `PREFIX_FINGERPRINT` file (written relative to this
 * module via `import.meta.url`) and returns its trimmed contents as a string.
 *
 * This is the T018 placeholder scaffold for DR-12 (prefix-stability
 * fingerprint / Q3 quality gate). Today the file holds a literal `<unset>`
 * sentinel; T046 wires the real SHA-256 computation over the
 * `stableSections` template bytes and the CI comparison check. The loader
 * here is intentionally small and does not hash, validate, or compare —
 * those responsibilities belong to the Q3 wiring task.
 */
export function loadPrefixFingerprint(): string {
  const fingerprintUrl = new URL('./PREFIX_FINGERPRINT', import.meta.url);
  const contents = readFileSync(fileURLToPath(fingerprintUrl), 'utf8');
  return contents.replace(/\s+$/u, '');
}
