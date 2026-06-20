import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { unlink } from 'node:fs/promises';
import { validatePath } from './path-validator.mts';

export function createFileDeleteTool(workingDirectory: string): StructuredTool {
  return tool(
    async ({ path }: { path: string }): Promise<string> => {
      try {
        const resolved = validatePath(path, workingDirectory);
        await unlink(resolved);
        return `File deleted: ${path}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error deleting file: ${message}`;
      }
    },
    {
      name: 'delete_file',
      description: 'Delete a file at the given relative path',
      schema: z.object({
        path: z.string().describe('Relative path to the file to delete'),
      }),
    },
  );
}
