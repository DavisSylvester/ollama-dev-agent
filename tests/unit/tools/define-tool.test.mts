import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { defineTool, toModelSchema } from '../../../src/tools/define-tool.mts';
import { createFileEditTool } from '../../../src/tools/file-edit.mts';
import { createTodoTools } from '../../../src/tools/todo.mts';

describe('toModelSchema', () => {
  it('drops defaulted properties from required, at any depth', () => {
    const schema = Type.Object({
      query: Type.String(),
      limit: Type.Number({ default: 5 }),
      items: Type.Array(
        Type.Object({
          content: Type.String(),
          status: Type.String({ default: 'pending' }),
        }),
      ),
    });

    const plain = toModelSchema(schema) as {
      required?: string[];
      properties: { items: { items: { required?: string[] } } };
    };

    expect(plain.required).toEqual(['query', 'items']);
    expect(plain.properties.items.items.required).toEqual(['content']);
  });

  it('removes required entirely when every property has a default', () => {
    const plain = toModelSchema(Type.Object({ fix: Type.Boolean({ default: false }) })) as { required?: string[] };
    expect(plain.required).toBeUndefined();
  });
});

describe('defineTool', () => {
  const echo = defineTool(
    async (input): Promise<string> => `${input.query}:${input.limit}`,
    {
      name: 'echo',
      description: 'echo the input',
      schema: Type.Object({
        query: Type.String(),
        limit: Type.Number({ default: 5 }),
      }),
    },
  );

  it('fills defaults before calling the handler', async () => {
    expect(await echo.invoke({ query: 'bun' })).toBe('bun:5');
  });

  it('passes explicit values through', async () => {
    expect(await echo.invoke({ query: 'bun', limit: 2 })).toBe('bun:2');
  });

  it('rejects input that fails the schema, naming the bad argument', async () => {
    // LangChain validates JSON Schema input before the handler runs and throws;
    // react-agent catches that and hands the message back to the model.
    const out: string = await echo.invoke({ query: 'bun', limit: 'many' }).then(String, (err: unknown) => String(err));
    expect(out).toMatch(/limit/);
  });
});

describe('converted tools keep their zod-era behaviour', () => {
  it('todo_write defaults a missing status to pending', async () => {
    const [write, read] = createTodoTools();
    await write!.invoke({ todos: [{ content: 'scaffold' }] });
    expect(await read!.invoke({})).toContain('[ ] scaffold');
  });
});

describe('edit_file', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oda-edit-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('inserts replacement text literally, without expanding $ patterns', async () => {
    await Bun.write(join(dir, 'a.mts'), 'const price = PLACEHOLDER;\n');
    const edit = createFileEditTool(dir);

    await edit.invoke({ path: 'a.mts', old_text: 'PLACEHOLDER', new_text: "'$& and $1 and $$'" });

    expect(await Bun.file(join(dir, 'a.mts')).text()).toBe("const price = '$& and $1 and $$';\n");
  });
});
