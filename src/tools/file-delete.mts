import { Type } from '@sinclair/typebox';
import type { StructuredTool } from '@langchain/core/tools';
import { defineTool } from './define-tool.mts';
import { unlink } from 'node:fs/promises';
import { validatePath } from './path-validator.mts';

export function createFileDeleteTool(workingDirectory: string): StructuredTool {
  return defineTool(
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
      schema: Type.Object({
        path: Type.String({ description: 'Relative path to the file to delete' }),
      }),
    },
  );
}
