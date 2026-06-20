import { describe, it, expect } from 'bun:test';
import { createTodoTools } from '../../../src/tools/todo.mts';

function tools(): { write: ReturnType<typeof createTodoTools>[number]; read: ReturnType<typeof createTodoTools>[number] } {
  const [write, read] = createTodoTools();
  return { write: write!, read: read! };
}

describe('todo tools', () => {
  it('exposes todo_write and todo_read', () => {
    const [write, read] = createTodoTools();
    expect(write!.name).toBe('todo_write');
    expect(read!.name).toBe('todo_read');
  });

  it('starts empty', async () => {
    const { read } = tools();
    expect(await read.invoke({})).toContain('empty');
  });

  it('writes and reads back the list with status marks', async () => {
    const { write, read } = tools();
    await write.invoke({
      todos: [
        { content: 'scaffold app', status: 'done' },
        { content: 'add health route', status: 'in_progress' },
        { content: 'add tests', status: 'pending' },
      ],
    });
    const out = await read.invoke({});
    expect(out).toContain('[x] scaffold app');
    expect(out).toContain('[~] add health route');
    expect(out).toContain('[ ] add tests');
  });

  it('replaces the full list on each write', async () => {
    const { write, read } = tools();
    await write.invoke({ todos: [{ content: 'first', status: 'pending' }] });
    await write.invoke({ todos: [{ content: 'second', status: 'done' }] });
    const out = await read.invoke({});
    expect(out).not.toContain('first');
    expect(out).toContain('[x] second');
  });

  it('defaults status to pending', async () => {
    const { write, read } = tools();
    await write.invoke({ todos: [{ content: 'no status given' }] });
    expect(await read.invoke({})).toContain('[ ] no status given');
  });

  it('keeps separate lists per tool-set instance', async () => {
    const a = tools();
    const b = tools();
    await a.write.invoke({ todos: [{ content: 'only in A', status: 'pending' }] });
    expect(await b.read.invoke({})).toContain('empty');
  });
});
