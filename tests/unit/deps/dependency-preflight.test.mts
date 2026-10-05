import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  floorOf,
  groupOf,
  regression,
  resetPreflightStateForTests,
  respec,
  runDependencyPreflight,
  summarizeForPrompt,
  type GateResult,
} from '../../../src/deps/dependency-preflight.mts';
import type { PackageVersions, RegistryLookup } from '../../../src/deps/registry.mts';

const REGISTRY: Record<string, PackageVersions> = {
  typescript: { latest: '7.0.2', versions: ['7.0.2', '7.0.0', '6.2.1', '6.0.3', '5.9.3'] },
  'typescript-eslint': { latest: '9.1.0', versions: ['9.1.0', '8.40.0'] },
  zod: { latest: '4.6.5', versions: ['4.6.5', '4.3.6'] },
  elysia: { latest: '1.4.30', versions: ['1.4.30'] },
};

const lookup: RegistryLookup = async (name) => REGISTRY[name] ?? null;

let dir = '';
let gateRuns = 0;

async function writePkg(content: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(content, null, 2)}\n`, 'utf-8');
}

async function readPkg(): Promise<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

/** A gate that fails typecheck (2 errors) whenever typescript is on major 7. */
function gate(baselineTypecheckErrors: number = 0): () => Promise<GateResult[]> {
  return async () => {
    gateRuns++;
    const pkg = await readPkg();
    const ts = pkg.devDependencies?.['typescript'] ?? '';
    const broken = ts.includes('7.');
    const errors = baselineTypecheckErrors + (broken ? 2 : 0);
    return [
      { name: 'typecheck', ok: errors === 0, score: errors, output: '' },
      { name: 'test', ok: true, score: 0, output: '' },
    ];
  };
}

const install = async (): Promise<boolean> => true;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oda-deps-'));
  gateRuns = 0;
  resetPreflightStateForTests();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('spec helpers', () => {
  it('reads the floor of managed specs and skips unmanaged ones', () => {
    expect(floorOf('^6.0.3')).toBe('6.0.3');
    expect(floorOf('~1.2.0')).toBe('1.2.0');
    expect(floorOf('7')).toBe('7.0.0');
    expect(floorOf('workspace:*')).toBeNull();
    expect(floorOf('file:../lib')).toBeNull();
    expect(floorOf('latest')).toBeNull();
  });

  it('keeps the spec style when rewriting', () => {
    expect(respec('^6.0.3', '7.0.2')).toBe('^7.0.2');
    expect(respec('~6.0.3', '7.0.2')).toBe('~7.0.2');
    expect(respec('6.0.3', '7.0.2')).toBe('7.0.2');
  });

  it('groups coupled packages together', () => {
    expect(groupOf('typescript')).toBe(groupOf('typescript-eslint'));
    expect(groupOf('@typescript-eslint/parser')).toBe('typescript');
    expect(groupOf('mongodb-memory-server')).toBe(groupOf('mongodb'));
    expect(groupOf('@angular/core')).toBe('@angular');
    expect(groupOf('zod')).toBe('zod');
  });
});

describe('regression', () => {
  const g = (name: string, ok: boolean, score: number): GateResult => ({ name, ok, score, output: '' });

  it('rejects a gate that passed before and fails after', () => {
    expect(regression([g('lint', true, 0)], [g('lint', false, 1)])).toContain('lint');
  });

  it('accepts an already-failing gate that did not get worse', () => {
    expect(regression([g('typecheck', false, 8)], [g('typecheck', false, 8)])).toBeNull();
  });

  it('rejects an already-failing gate whose failures rose', () => {
    expect(regression([g('typecheck', false, 8)], [g('typecheck', false, 10)])).toContain('8 to 10');
  });
});

describe('runDependencyPreflight', () => {
  it('upgrades everything when the gate stays green', async () => {
    await writePkg({ dependencies: { zod: '^4.3.6', elysia: '^1.4.30' }, devDependencies: { 'typescript-eslint': '^8.40.0' } });

    const report = await runDependencyPreflight(dir, { lookup, install, runGate: gate() });

    const pkg = await readPkg();
    expect(pkg.dependencies?.['zod']).toBe('^4.6.5');
    expect(pkg.dependencies?.['elysia']).toBe('^1.4.30'); // already latest: untouched
    expect(pkg.devDependencies?.['typescript-eslint']).toBe('^9.1.0');
    expect(report.upgraded.map((u) => u.name).sort()).toEqual(['typescript-eslint', 'zod']);
    expect(report.pinned).toEqual([]);
    expect(await readFile(join(dir, 'docs', 'DEPENDENCIES.md'), 'utf-8')).toContain('| `zod` | 4.3.6 | 4.6.5 |');
  });

  it('pins a breaking major at the newest release of its current major, and still upgrades the rest', async () => {
    await writePkg({ dependencies: { zod: '^4.3.6' }, devDependencies: { typescript: '^6.0.3' } });

    const report = await runDependencyPreflight(dir, { lookup, install, runGate: gate() });

    const pkg = await readPkg();
    expect(pkg.devDependencies?.['typescript']).toBe('^6.2.1');
    expect(pkg.dependencies?.['zod']).toBe('^4.6.5');
    expect(report.pinned).toHaveLength(1);
    expect(report.pinned[0]).toMatchObject({ name: 'typescript', current: '6.2.1', latest: '7.0.2' });
    expect(report.pinned[0]?.reason).toContain('typecheck');
    expect(summarizeForPrompt(report)).toContain('`typescript` 6.2.1 (latest 7.0.2');
  });

  it('upgrades a project whose gate already fails, as long as it gets no worse', async () => {
    await writePkg({ dependencies: { zod: '^4.3.6' } });
    const report = await runDependencyPreflight(dir, { lookup, install, runGate: gate(8) });
    expect(report.upgraded.map((u) => u.name)).toEqual(['zod']);
  });

  it('restores package.json when bun install fails', async () => {
    await writePkg({ dependencies: { zod: '^4.3.6' } });
    const report = await runDependencyPreflight(dir, { lookup, install: async () => false, runGate: gate() });
    expect((await readPkg()).dependencies?.['zod']).toBe('^4.3.6');
    expect(report.upgraded).toEqual([]);
    expect(report.pinned[0]?.reason).toContain('bun install failed');
  });

  it('does not re-gate a pin it already decided for the same latest release', async () => {
    await writePkg({ devDependencies: { typescript: '^6.0.3' } });
    await runDependencyPreflight(dir, { lookup, install, runGate: gate() });
    const runsAfterFirst = gateRuns;

    const second = await runDependencyPreflight(dir, { lookup, install, runGate: gate() });
    expect(gateRuns).toBe(runsAfterFirst);
    expect(second.pinned[0]?.name).toBe('typescript');
  });

  it('does nothing when every dependency is current', async () => {
    await writePkg({ dependencies: { elysia: '^1.4.30' } });
    const report = await runDependencyPreflight(dir, { lookup, install, runGate: gate() });
    expect(gateRuns).toBe(0);
    expect(summarizeForPrompt(report)).toContain('newest release');
  });
});
