/**
 * Remote version check for the Exarchos installer.
 *
 * Compares the running installer version against the latest on GitHub main.
 * Network failures are non-fatal — the install proceeds regardless.
 */

const DEFAULT_URL =
  'https://raw.githubusercontent.com/lvlup-sw/exarchos/main/package.json';
const DEFAULT_TIMEOUT_MS = 3000;

/** Result of comparing local version against remote. */
export interface VersionCheckResult {
  /** Whether the versions match, differ, or the check failed. */
  readonly status: 'current' | 'outdated' | 'error';
  /** Local (running) version. */
  readonly localVersion: string;
  /** Remote (latest) version, if fetched successfully. */
  readonly remoteVersion?: string;
  /** Error message if the check failed. */
  readonly error?: string;
}

/** Options for the version check (supports dependency injection for tests). */
export interface VersionCheckOptions {
  /** Timeout in milliseconds for the fetch request. Defaults to 3000. */
  readonly timeoutMs?: number;
  /** Override the URL to fetch. */
  readonly url?: string;
  /** Override the fetch function. */
  readonly fetchFn?: typeof fetch;
}

/** Type guard for a response body with a string `version` field. */
function hasVersion(value: unknown): value is { version: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof (value as Record<string, unknown>).version === 'string'
  );
}

/**
 * Check the running installer version against the latest on GitHub.
 *
 * Fetches package.json from the main branch and compares version fields.
 * Returns within the timeout period; network failures are non-fatal.
 *
 * @param localVersion - The version of the currently running installer.
 * @param options - Optional configuration for timeout, URL, and fetch override.
 * @returns The version check result.
 */
export async function checkVersion(
  localVersion: string,
  options?: VersionCheckOptions,
): Promise<VersionCheckResult> {
  const url = options?.url ?? DEFAULT_URL;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options?.fetchFn ?? fetch;

  try {
    const response = await fetchFn(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return {
        status: 'error',
        localVersion,
        error: `HTTP ${response.status}`,
      };
    }

    const body: unknown = await response.json();

    if (!hasVersion(body)) {
      return {
        status: 'error',
        localVersion,
        error: 'Remote package.json missing version field',
      };
    }

    const remoteVersion = body.version;

    if (localVersion === remoteVersion) {
      return { status: 'current', localVersion, remoteVersion };
    }

    return { status: 'outdated', localVersion, remoteVersion };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'error', localVersion, error: message };
  }
}

/**
 * Format a version mismatch warning for terminal display.
 *
 * @param result - The version check result (should have status 'outdated').
 * @returns Multi-line warning string.
 */
export function formatVersionWarning(result: VersionCheckResult): string {
  const lines = [
    '  \u26A0  Version mismatch detected',
    `     Running: ${result.localVersion} \u2014 Latest: ${result.remoteVersion}`,
    '     Run with the latest version:',
    '       npx -y github:lvlup-sw/exarchos@main',
  ];
  return lines.join('\n');
}
