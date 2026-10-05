import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import semver from 'semver';
import { logger } from '../logger.mts';

const REGISTRY = 'https://registry.npmjs.org';
const LOOKUP_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Stable versions of one package, newest first, plus the `latest` dist-tag. */
export interface PackageVersions {
  latest: string;
  versions: string[];
}

export type RegistryLookup = (name: string) => Promise<PackageVersions | null>;

interface CacheEntry {
  fetchedAt: number;
  data: PackageVersions;
}

const cachePath = (): string => join(homedir(), '.oda', 'registry-cache.json');

let memory: Map<string, CacheEntry> | undefined;

async function loadCache(): Promise<Map<string, CacheEntry>> {
  if (memory) return memory;
  memory = new Map();
  try {
    const raw: unknown = JSON.parse(await readFile(cachePath(), 'utf-8'));
    if (typeof raw === 'object' && raw !== null) {
      for (const [name, entry] of Object.entries(raw)) {
        memory.set(name, entry as CacheEntry);
      }
    }
  } catch {
    // No cache yet, or unreadable — start empty.
  }
  return memory;
}

async function saveCache(cache: Map<string, CacheEntry>): Promise<void> {
  try {
    await mkdir(dirname(cachePath()), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(Object.fromEntries(cache)), 'utf-8');
  } catch (err) {
    logger.warn({ error: String(err) }, 'registry.cache_write_failed');
  }
}

/**
 * Look up a package's published stable versions on npm, cached for 24 hours
 * (in memory and in ~/.oda/registry-cache.json). Uses the abbreviated
 * "install" metadata document, which lists versions without full manifests.
 * Returns null when the registry can't be reached or the package is unknown.
 */
export const lookupPackage: RegistryLookup = async (name) => {
  const cache = await loadCache();
  const hit = cache.get(name);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.data;

  try {
    const url = `${REGISTRY}/${name.replace('/', '%2F')}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn({ name, status: response.status }, 'registry.lookup_failed');
      return null;
    }
    const body = (await response.json()) as { 'dist-tags'?: { latest?: unknown }; versions?: Record<string, unknown> };
    const latest = body['dist-tags']?.latest;
    if (typeof latest !== 'string' || !semver.valid(latest)) return null;

    const versions = Object.keys(body.versions ?? {})
      .filter((v) => semver.valid(v) && semver.prerelease(v) === null)
      .sort(semver.rcompare);

    const data: PackageVersions = { latest, versions };
    cache.set(name, { fetchedAt: Date.now(), data });
    await saveCache(cache);
    return data;
  } catch (err) {
    logger.warn({ name, error: err instanceof Error ? err.message : String(err) }, 'registry.lookup_failed');
    return null;
  }
};

/** Newest stable version with the same major as `version`, if newer than it. */
export function newestInMajor(versions: PackageVersions, version: string): string | null {
  const major = semver.major(version);
  const candidate = versions.versions.find((v) => semver.major(v) === major);
  return candidate && semver.gt(candidate, version) ? candidate : null;
}

// Exported for unit testing
export function resetRegistryCacheForTests(): void {
  memory = new Map();
}
