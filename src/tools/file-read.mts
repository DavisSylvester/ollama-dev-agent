import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { validatePath } from './path-validator.mts';

export function createFileReadTool(workingDirectory: string): StructuredTool {
  return tool(
    async ({ path }: { path: string }): Promise<string> => {
      try {
        const resolved = validatePath(path, workingDirectory);
        const file = Bun.file(resolved);
        const exists = await file.exists();
        if (!exists) {
          return `Error reading file: File not found: ${path}`;
        }
        return await file.text();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error reading file: ${message}`;
      }
    },
    {
      name: 'read_file',
      description: 'Read the contents of a file at the given relative path',
      schema: z.object({
        path: z.string().describe('Relative path to read'),
      }),
    },
  );
}
