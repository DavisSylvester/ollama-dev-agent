import { Type } from '@sinclair/typebox';
import type { StructuredTool } from '@langchain/core/tools';
import { defineTool } from './define-tool.mts';
import { validatePath } from './path-validator.mts';

export function createFileReadTool(workingDirectory: string): StructuredTool {
  return defineTool(
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
      schema: Type.Object({
        path: Type.String({ description: 'Relative path to read' }),
      }),
    },
  );
}
