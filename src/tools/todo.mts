import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

type TodoStatus = 'pending' | 'in_progress' | 'done';

interface TodoItem {
  content: string;
  status: TodoStatus;
}

const STATUS_MARK: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
};

function render(items: TodoItem[]): string {
  if (items.length === 0) return 'Todo list is empty.';
  return items.map((t) => `- ${STATUS_MARK[t.status]} ${t.content}`).join('\n');
}

/**
 * In-task todo scratchpad. Returns `todo_write` and `todo_read` tools that share
 * one in-memory list, letting a worker decompose its task into steps and track
 * progress within its own context. The list lives for the lifetime of this tool
 * set (one task, across its iterations).
 */
export function createTodoTools(): StructuredTool[] {
  const items: TodoItem[] = [];

  const writeTool = tool(
    async ({ todos }: { todos: Array<{ content: string; status?: TodoStatus }> }): Promise<string> => {
      items.length = 0;
      for (const t of todos) {
        items.push({ content: t.content, status: t.status ?? 'pending' });
      }
      return `Todo list updated:\n${render(items)}`;
    },
    {
      name: 'todo_write',
      description:
        'Set or update your task todo list. Pass the full list each time (it replaces the previous one). ' +
        'Use this to break the task into steps and track progress (pending/in_progress/done).',
      schema: z.object({
        todos: z
          .array(
            z.object({
              content: z.string().describe('What the step does'),
              status: z.enum(['pending', 'in_progress', 'done']).default('pending').describe('Step status'),
            }),
          )
          .describe('The complete todo list'),
      }),
    },
  );

  const readTool = tool(
    async (): Promise<string> => render(items),
    {
      name: 'todo_read',
      description: 'Read your current task todo list and the status of each step.',
      schema: z.object({}),
    },
  );

  return [writeTool, readTool];
}
