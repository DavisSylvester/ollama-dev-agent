import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileReadTool } from '../../src/tools/file-read.mts';
import { createFileWriteTool } from '../../src/tools/file-write.mts';
import { createFileEditTool } from '../../src/tools/file-edit.mts';
import { createFileDeleteTool } from '../../src/tools/file-delete.mts';
import { createListDirectoryTool } from '../../src/tools/list-directory.mts';
import { createGlobSearchTool } from '../../src/tools/glob-search.mts';
import { createGrepSearchTool } from '../../src/tools/grep-search.mts';
import { validatePath } from '../../src/tools/path-validator.mts';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'oda-test-'));
  await writeFile(join(tempDir, 'hello.ts'), 'export const hello = "world";\n');
  await writeFile(join(tempDir, 'README.md'), '# Test Project\n\nThis is a test.\n');
  await mkdir(join(tempDir, 'src'));
  await writeFile(join(tempDir, 'src', 'index.ts'), 'console.log("hello");\n');
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('validatePath', () => {
  it('allows paths within working directory', () => {
    const result = validatePath('src/index.ts', tempDir);
    expect(result).toContain('index.ts');
  });

  it('allows nested relative paths', () => {
    const result = validatePath('./src/../src/index.ts', tempDir);
    expect(result).toContain('index.ts');
  });

  it('rejects paths outside working directory', () => {
    expect(() => validatePath('../escape.ts', tempDir)).toThrow('outside the working directory');
  });

  it('rejects absolute paths outside working directory', () => {
    expect(() => validatePath('/etc/passwd', tempDir)).toThrow('outside the working directory');
  });
});

describe('read_file tool', () => {
  it('reads an existing file', async () => {
    const tool = createFileReadTool(tempDir);
    const result = await tool.invoke({ path: 'hello.ts' });
    expect(result).toContain('hello');
    expect(result).toContain('world');
  });

  it('returns error string for missing file', async () => {
    const tool = createFileReadTool(tempDir);
    const result = await tool.invoke({ path: 'nonexistent.ts' });
    expect(result).toMatch(/error/i);
  });

  it('rejects paths outside working directory', async () => {
    const tool = createFileReadTool(tempDir);
    const result = await tool.invoke({ path: '../escape.ts' });
    expect(result).toMatch(/outside|error/i);
  });
});

describe('write_file tool', () => {
  it('creates a new file', async () => {
    const tool = createFileWriteTool(tempDir);
    const result = await tool.invoke({ path: 'new-file.ts', content: 'const x = 1;\n' });
    expect(result).toContain('new-file.ts');

    const readTool = createFileReadTool(tempDir);
    const content = await readTool.invoke({ path: 'new-file.ts' });
    expect(content).toContain('const x = 1');
  });

  it('creates parent directories as needed', async () => {
    const tool = createFileWriteTool(tempDir);
    const result = await tool.invoke({ path: 'deep/nested/file.ts', content: 'export {};\n' });
    expect(result).toContain('deep/nested/file.ts');
  });

  it('rejects paths outside working directory', async () => {
    const tool = createFileWriteTool(tempDir);
    const result = await tool.invoke({ path: '../outside.ts', content: 'bad' });
    expect(result).toMatch(/outside|error/i);
  });
});

describe('edit_file tool', () => {
  it('replaces text in a file', async () => {
    const tool = createFileEditTool(tempDir);
    const result = await tool.invoke({
      path: 'hello.ts',
      old_text: '"world"',
      new_text: '"universe"',
    });
    expect(result).toContain('hello.ts');

    const readTool = createFileReadTool(tempDir);
    const content = await readTool.invoke({ path: 'hello.ts' });
    expect(content).toContain('universe');
  });

  it('returns error when text not found', async () => {
    const tool = createFileEditTool(tempDir);
    const result = await tool.invoke({
      path: 'hello.ts',
      old_text: 'does not exist in file',
      new_text: 'replacement',
    });
    expect(result).toMatch(/not found|error/i);
  });
});

describe('delete_file tool', () => {
  it('deletes an existing file', async () => {
    await writeFile(join(tempDir, 'to-delete.ts'), 'delete me\n');
    const tool = createFileDeleteTool(tempDir);
    const result = await tool.invoke({ path: 'to-delete.ts' });
    expect(result).toContain('to-delete.ts');

    const readTool = createFileReadTool(tempDir);
    const content = await readTool.invoke({ path: 'to-delete.ts' });
    expect(content).toMatch(/error/i);
  });
});

describe('list_directory tool', () => {
  it('lists files and directories', async () => {
    const tool = createListDirectoryTool(tempDir);
    const result = await tool.invoke({ path: '.' });
    const entries = JSON.parse(result) as Array<{ name: string; type: string }>;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.some(e => e.name === 'hello.ts')).toBe(true);
    expect(entries.some(e => e.name === 'src' && e.type === 'directory')).toBe(true);
  });
});

describe('glob_search tool', () => {
  it('finds files matching pattern', async () => {
    const tool = createGlobSearchTool(tempDir);
    const result = await tool.invoke({ pattern: '**/*.ts' });
    expect(result).toContain('hello.ts');
    expect(result).toContain('src/index.ts');
  });

  it('returns empty for non-matching pattern', async () => {
    const tool = createGlobSearchTool(tempDir);
    const result = await tool.invoke({ pattern: '**/*.xyz' });
    expect(result.trim()).toBe('');
  });
});

describe('grep_search tool', () => {
  it('finds matching content', async () => {
    const tool = createGrepSearchTool(tempDir);
    const result = await tool.invoke({ pattern: 'hello', path: '.' });
    const matches = JSON.parse(result) as Array<{ file: string; line: number; content: string }>;
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('returns empty array for no matches', async () => {
    const tool = createGrepSearchTool(tempDir);
    const result = await tool.invoke({ pattern: 'xyzzy_not_found_anywhere' });
    const matches = JSON.parse(result) as unknown[];
    expect(matches).toHaveLength(0);
  });
});
