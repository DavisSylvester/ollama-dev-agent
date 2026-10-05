import { logger } from '../logger.mts';

const REGISTRY_URL = 'https://registry.npmjs.org/typescript/latest';
const LOOKUP_TIMEOUT_MS = 5000;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

// Resolved once per process: "latest" means latest as of the day oda runs, so a
// single lookup per run is enough and every task sees the same version.
let cached: Promise<string | null> | undefined;

/**
 * Look up the newest stable TypeScript version published to npm right now.
 * Returns null when the registry is unreachable so callers can fall back to a
 * "use the latest" instruction without a concrete version number.
 */
export function resolveLatestTypeScriptVersion(): Promise<string | null> {
  cached ??= fetchLatestVersion();
  return cached;
}

// Exported for unit testing
export function resetTypeScriptVersionCache(): void {
  cached = undefined;
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'typescript_version.lookup_failed');
      return null;
    }
    const body = (await response.json()) as { version?: unknown };
    const version = typeof body.version === 'string' ? body.version : '';
    if (!SEMVER_PATTERN.test(version)) {
      logger.warn({ version }, 'typescript_version.unexpected_version');
      return null;
    }
    logger.info({ version }, 'typescript_version.resolved');
    return version;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ error: message }, 'typescript_version.lookup_failed');
    return null;
  }
}

/**
 * Prompt text telling a worker (or reviewer) which TypeScript version to use.
 * With no resolved version it still demands the latest, resolved via bun.
 */
export function formatTypeScriptVersionRule(latestVersion: string | null): string {
  const target = latestVersion
    ? `**${latestVersion}** (the newest stable release on npm as of today)`
    : 'the newest stable release on npm as of today (check with `bun pm view typescript version`)';

  return [
    `- **TypeScript version**: always use ${target}.`,
    latestVersion
      ? `  - In every \`package.json\` that lists \`typescript\`, pin it to \`^${latestVersion}\`; install with \`bun add -d typescript@${latestVersion}\``
      : '  - In every `package.json` that lists `typescript`, pin it to that version; install with `bun add -d typescript@latest`',
    '  - If `typescript` is already listed at an older version, upgrade it — this is the one exception to "do not re-add installed packages"',
    '  - Never hand-write an older version (for example `^5.x`) into `package.json`',
    '  - **Compatibility fallback only**: if the build or lint breaks because a required tool (Angular, typescript-eslint, ts-node) does not support that version yet, pin the newest version that tool does support and state the version and the reason in your report',
  ].join('\n');
}
