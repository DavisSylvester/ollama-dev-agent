import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { execa } from 'execa';
import { glob } from 'glob';
import semver from 'semver';
import { DateTime } from 'luxon';
import { logger } from '../logger.mts';
import { lookupPackage, newestInMajor, type RegistryLookup } from './registry.mts';

// ---------------------------------------------------------------------------
// Dependency preflight: keep every direct dependency on its newest version,
// enforced by oda itself rather than asked of the model. Upgrades are kept
// only when the project's own gate (typecheck, lint, test) gets no worse, and
// every decision is recorded in docs/DEPENDENCIES.md.
// ---------------------------------------------------------------------------

const DEP_FIELDS = ['dependencies', 'devDependencies'] as const;
type DepField = (typeof DEP_FIELDS)[number];

const GATE_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** One direct dependency declared in one package.json. */
export interface DeclaredDependency {
  file: string;
  field: DepField;
  name: string;
  spec: string;
}

/** A dependency whose declared floor is older than the newest release. */
export interface OutdatedDependency extends DeclaredDependency {
  current: string;
  latest: string;
  group: string;
}

export interface UpgradeRecord {
  name: string;
  from: string;
  to: string;
}

export interface PinRecord {
  name: string;
  current: string;
  latest: string;
  reason: string;
}

export interface DependencyReport {
  checkedAt: string;
  upgraded: UpgradeRecord[];
  pinned: PinRecord[];
}

export interface GateResult {
  name: string;
  ok: boolean;
  score: number;
  output: string;
}

export interface PreflightDeps {
  lookup?: RegistryLookup;
  install?: (cwd: string) => Promise<boolean>;
  runGate?: (cwd: string) => Promise<GateResult[]>;
}

// Packages that must move together; anything else groups by npm scope.
const COUPLED: ReadonlyArray<[RegExp, string]> = [
  [/^(typescript|typescript-eslint|@typescript-eslint\/.+)$/, 'typescript'],
  [/^(eslint|@eslint\/.+)$/, 'eslint'],
  [/^(mongodb|mongodb-memory-server(-core)?)$/, 'mongodb'],
];

export function groupOf(name: string): string {
  for (const [pattern, group] of COUPLED) {
    if (pattern.test(name)) return group;
  }
  return name.startsWith('@') ? (name.split('/')[0] ?? name) : name;
}

/** The lowest version a spec allows, or null for specs oda doesn't manage. */
export function floorOf(spec: string): string | null {
  if (/^(workspace:|file:|link:|git|http|npm:|github:)/.test(spec)) return null;
  if (spec === '*' || spec === 'latest' || !semver.validRange(spec)) return null;
  return semver.minVersion(spec)?.version ?? null;
}

/** Rewrite a spec to a new version, keeping its style (^, ~ or exact). */
export function respec(spec: string, version: string): string {
  if (spec.startsWith('~')) return `~${version}`;
  if (semver.valid(spec)) return version;
  return `^${version}`;
}

async function packageFiles(cwd: string): Promise<string[]> {
  const files = await glob('**/package.json', {
    cwd,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.angular/**', '**/.worktrees/**', '**/.silo/**'],
    absolute: true,
  });
  return files.sort();
}

export async function readDeclared(cwd: string): Promise<DeclaredDependency[]> {
  const out: DeclaredDependency[] = [];
  for (const file of await packageFiles(cwd)) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const field of DEP_FIELDS) {
      const deps = pkg[field];
      if (typeof deps !== 'object' || deps === null) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec === 'string') out.push({ file, field, name, spec });
      }
    }
  }
  return out;
}

export async function findOutdated(cwd: string, lookup: RegistryLookup): Promise<OutdatedDependency[]> {
  const declared = await readDeclared(cwd);
  const names = [...new Set(declared.map((d) => d.name))];
  const latest = new Map<string, string>();
  await Promise.all(
    names.map(async (name) => {
      const info = await lookup(name);
      if (info) latest.set(name, info.latest);
    }),
  );

  const out: OutdatedDependency[] = [];
  for (const dep of declared) {
    const current = floorOf(dep.spec);
    const newest = latest.get(dep.name);
    if (!current || !newest || semver.prerelease(newest) !== null) continue;
    if (semver.lt(current, newest)) {
      out.push({ ...dep, current, latest: newest, group: groupOf(dep.name) });
    }
  }
  return out;
}

// --- Applying and reverting ----------------------------------------------

interface Snapshot {
  files: Map<string, string>;
}

async function snapshot(cwd: string): Promise<Snapshot> {
  const files = new Map<string, string>();
  const candidates = [...(await packageFiles(cwd)), join(cwd, 'bun.lock'), join(cwd, 'bun.lockb')];
  for (const file of candidates) {
    try {
      files.set(file, await readFile(file, 'utf-8'));
    } catch {
      // Missing lockfile — nothing to restore.
    }
  }
  return { files };
}

async function restore(snap: Snapshot): Promise<void> {
  for (const [file, content] of snap.files) {
    await writeFile(file, content, 'utf-8');
  }
}

/** Write the given versions into their package.json files, keeping formatting. */
async function applyVersions(bumps: ReadonlyArray<{ dep: DeclaredDependency; to: string }>): Promise<void> {
  const byFile = new Map<string, Array<{ dep: DeclaredDependency; to: string }>>();
  for (const bump of bumps) {
    const list = byFile.get(bump.dep.file) ?? [];
    list.push(bump);
    byFile.set(bump.dep.file, list);
  }
  for (const [file, list] of byFile) {
    const text = await readFile(file, 'utf-8');
    const indent = /^(\s+)"/m.exec(text)?.[1] ?? '  ';
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const pkg = JSON.parse(text) as Record<string, Record<string, string>>;
    for (const { dep, to } of list) {
      const section = pkg[dep.field];
      if (section) section[dep.name] = respec(dep.spec, to);
    }
    const body = JSON.stringify(pkg, null, indent).replace(/\n/g, eol);
    // Keep the file's own ending: only add a final newline if it had one.
    const trailing = /\r?\n$/.test(text) ? eol : '';
    await writeFile(file, `${body}${trailing}`, 'utf-8');
  }
}

// --- Gate ------------------------------------------------------------------

async function defaultInstall(cwd: string): Promise<boolean> {
  const result = await execa('bun', ['install'], { cwd, reject: false, timeout: INSTALL_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    logger.warn({ output: `${result.stdout}\n${result.stderr}`.slice(-1500) }, 'deps.install_failed');
  }
  return result.exitCode === 0;
}

// Lines that indicate a distinct failure in tsc / eslint / bun test output.
const FAILURE_LINE = /error TS\d+|\(fail\)|^\s*\d+:\d+\s+error\s/;

export function failureScore(output: string): number {
  return output.split(/\r?\n/).filter((line) => FAILURE_LINE.test(line)).length;
}

async function gateCommands(cwd: string): Promise<Array<{ name: string; cmd: string; args: string[] }>> {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    // No root package.json — fall back to defaults below.
  }
  const commands: Array<{ name: string; cmd: string; args: string[] }> = [];
  const typecheck = ['typecheck', 'type-check'].find((s) => s in scripts);
  if (typecheck) commands.push({ name: 'typecheck', cmd: 'bun', args: ['run', typecheck] });
  else commands.push({ name: 'typecheck', cmd: 'bunx', args: ['tsc', '--noEmit'] });
  if ('lint' in scripts) commands.push({ name: 'lint', cmd: 'bun', args: ['run', 'lint'] });
  commands.push({ name: 'test', cmd: 'bun', args: 'test' in scripts ? ['run', 'test'] : ['test'] });
  return commands;
}

async function defaultRunGate(cwd: string): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const { name, cmd, args } of await gateCommands(cwd)) {
    const result = await execa(cmd, args, { cwd, reject: false, timeout: GATE_TIMEOUT_MS, all: true });
    const output = result.all ?? `${result.stdout}\n${result.stderr}`;
    results.push({ name, ok: result.exitCode === 0, score: failureScore(output), output: output.slice(-4000) });
  }
  return results;
}

/**
 * An upgrade is acceptable when nothing got worse: every gate that passed
 * before still passes, and no failing gate reports more failures than before.
 * (A project mid-build may already fail some gates; that alone must not block
 * upgrades.) Returns the first regression, or null.
 */
export function regression(baseline: GateResult[], after: GateResult[]): string | null {
  for (const before of baseline) {
    const now = after.find((g) => g.name === before.name);
    if (!now) continue;
    if (before.ok && !now.ok) return `${now.name} passed before and fails after the upgrade`;
    if (!before.ok && now.score > before.score) {
      return `${now.name} failures rose from ${before.score} to ${now.score}`;
    }
  }
  return null;
}

// --- Report ----------------------------------------------------------------

export function renderReport(report: DependencyReport): string {
  const lines: string[] = [
    '# Dependencies',
    '',
    `Managed by oda's dependency preflight (last checked ${report.checkedAt}). Every direct`,
    'dependency is kept on its newest release unless the upgrade made typecheck, lint or tests',
    'worse; those are pinned below with the reason. Do not change these versions by hand in a task.',
    '',
  ];
  if (report.upgraded.length > 0) {
    lines.push('## Upgraded', '', '| Package | From | To |', '|---|---|---|');
    for (const u of report.upgraded) lines.push(`| \`${u.name}\` | ${u.from} | ${u.to} |`);
    lines.push('');
  }
  if (report.pinned.length > 0) {
    lines.push('## Pinned below latest', '', '| Package | Kept at | Latest | Why |', '|---|---|---|---|');
    for (const p of report.pinned) lines.push(`| \`${p.name}\` | ${p.current} | ${p.latest} | ${p.reason} |`);
    lines.push('');
  }
  if (report.upgraded.length === 0 && report.pinned.length === 0) {
    lines.push('All direct dependencies are on their newest release.', '');
  }
  return lines.join('\n');
}

/** One-paragraph summary for worker and reviewer prompts. */
export function summarizeForPrompt(report: DependencyReport | null): string {
  if (!report) return '';
  const pins = report.pinned.map((p) => `\`${p.name}\` ${p.current} (latest ${p.latest}: ${p.reason})`);
  return pins.length > 0
    ? `Pinned below latest by oda, deliberately: ${pins.join('; ')}.`
    : 'Every existing direct dependency is on its newest release.';
}

// --- Main ------------------------------------------------------------------

const reports = new Map<string, DependencyReport>();

// "name@latest" pins already decided per working directory, so a package that
// can't move to its latest release isn't re-gated before every batch. A newer
// release changes the key, which triggers a fresh attempt.
const decidedPins = new Map<string, Set<string>>();

// Exported for unit testing
export function resetPreflightStateForTests(): void {
  reports.clear();
  decidedPins.clear();
}

/** The last preflight report for a working directory in this process. */
export function getDependencyReport(cwd: string): DependencyReport | null {
  return reports.get(cwd) ?? null;
}

/**
 * Bring every direct dependency in `cwd` up to its newest release, keeping
 * only upgrades that don't make the project's gate worse. Must run while no
 * task is writing to the tree (between scheduler batches).
 *
 * 1. Optimistic: upgrade everything, install, gate. Keep it all if nothing regressed.
 * 2. Otherwise restore, then upgrade one coupled group at a time; a group that
 *    regresses is retried at the newest release of its current major, and
 *    pinned at its current version if that regresses too.
 */
export async function runDependencyPreflight(cwd: string, deps: PreflightDeps = {}): Promise<DependencyReport> {
  const lookup = deps.lookup ?? lookupPackage;
  const install = deps.install ?? defaultInstall;
  const runGate = deps.runGate ?? defaultRunGate;
  const report: DependencyReport = { checkedAt: DateTime.utc().toISO() ?? '', upgraded: [], pinned: [] };

  const decided = decidedPins.get(cwd) ?? new Set<string>();
  decidedPins.set(cwd, decided);
  const previous = reports.get(cwd);

  const outdated = (await findOutdated(cwd, lookup)).filter((dep) => !decided.has(`${dep.name}@${dep.latest}`));
  if (outdated.length === 0) {
    // Nothing new to try — keep reporting the pins already decided.
    const unchanged: DependencyReport = previous ?? report;
    reports.set(cwd, unchanged);
    return unchanged;
  }

  logger.info({ count: outdated.length, packages: [...new Set(outdated.map((o) => o.name))] }, 'deps.outdated');
  const baseline = await runGate(cwd);
  const start = await snapshot(cwd);

  const tryBumps = async (bumps: Array<{ dep: OutdatedDependency; to: string }>): Promise<string | null> => {
    const before = await snapshot(cwd);
    await applyVersions(bumps);
    if (!(await install(cwd))) {
      await restore(before);
      await install(cwd);
      return 'bun install failed';
    }
    const problem = regression(baseline, await runGate(cwd));
    if (problem) {
      await restore(before);
      await install(cwd);
    }
    return problem;
  };

  const record = (dep: OutdatedDependency, to: string): void => {
    if (!report.upgraded.some((u) => u.name === dep.name)) report.upgraded.push({ name: dep.name, from: dep.current, to });
  };

  const all = outdated.map((dep) => ({ dep, to: dep.latest }));
  const optimistic = await tryBumps(all);
  if (optimistic === null) {
    for (const { dep, to } of all) record(dep, to);
  } else {
    logger.info({ reason: optimistic }, 'deps.optimistic_upgrade_rejected');
    await restore(start);
    await install(cwd);

    const groups = new Map<string, OutdatedDependency[]>();
    for (const dep of outdated) groups.set(dep.group, [...(groups.get(dep.group) ?? []), dep]);

    for (const [group, members] of groups) {
      const latestProblem = await tryBumps(members.map((dep) => ({ dep, to: dep.latest })));
      if (latestProblem === null) {
        for (const dep of members) record(dep, dep.latest);
        continue;
      }

      // Fall back to the newest release within each member's current major.
      const fallback: Array<{ dep: OutdatedDependency; to: string }> = [];
      for (const dep of members) {
        const info = await lookup(dep.name);
        const inMajor = info ? newestInMajor(info, dep.current) : null;
        if (inMajor) fallback.push({ dep, to: inMajor });
      }
      const fallbackProblem = fallback.length > 0 ? await tryBumps(fallback) : 'no newer release in the current major';
      if (fallbackProblem === null) {
        for (const { dep, to } of fallback) record(dep, to);
      }
      for (const dep of members) {
        const kept = fallbackProblem === null ? (fallback.find((f) => f.dep === dep)?.to ?? dep.current) : dep.current;
        if (!report.pinned.some((p) => p.name === dep.name)) {
          report.pinned.push({ name: dep.name, current: kept, latest: dep.latest, reason: `${group} @latest: ${latestProblem}` });
        }
      }
    }
  }

  for (const pin of report.pinned) decided.add(`${pin.name}@${pin.latest}`);
  // Carry earlier pins that weren't re-attempted this time.
  for (const pin of previous?.pinned ?? []) {
    if (!report.pinned.some((p) => p.name === pin.name) && !report.upgraded.some((u) => u.name === pin.name)) {
      report.pinned.push(pin);
    }
  }

  reports.set(cwd, report);
  try {
    const docPath = join(cwd, 'docs', 'DEPENDENCIES.md');
    await mkdir(dirname(docPath), { recursive: true });
    await writeFile(docPath, renderReport(report), 'utf-8');
  } catch (err) {
    logger.warn({ error: String(err) }, 'deps.report_write_failed');
  }
  logger.info(
    {
      upgraded: report.upgraded.map((u) => `${u.name}@${u.to}`),
      pinned: report.pinned.map((p) => `${p.name}@${p.current}`),
      files: [...new Set(outdated.map((o) => relative(cwd, o.file)))],
    },
    'deps.preflight_complete',
  );
  return report;
}
