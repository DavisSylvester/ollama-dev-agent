/**
 * Worker-prompt rule for dependency versions. oda's dependency preflight keeps
 * every direct dependency on its newest release (or pins it with a recorded
 * reason), so the worker must not change versions itself — that used to leave
 * the reviewer demanding an upgrade the worker never made.
 */
export function formatDependencyRule(dependencySummary: string): string {
  return [
    '- **Dependency versions are managed by oda**: before each batch it upgrades every existing dependency to its newest release, or pins it with the reason recorded in `docs/DEPENDENCIES.md`.',
    '  - Do **not** change the version of a package already listed in a `package.json` — not up, not down.',
    '  - Add a new package with `bun add <package>` (or `bun add -d <package>`), which installs its newest release. Never hand-write an older version.',
    ...(dependencySummary ? [`  - ${dependencySummary}`] : []),
  ].join('\n');
}
