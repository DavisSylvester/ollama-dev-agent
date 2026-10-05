import { Type } from '@sinclair/typebox';
import type { StructuredTool } from '@langchain/core/tools';
import { defineTool } from './define-tool.mts';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validatePath } from './path-validator.mts';

export function createFileWriteTool(workingDirectory: string): StructuredTool {
  return defineTool(
    async ({ path, content }: { path: string; content: string }): Promise<string> => {
      try {
        const resolved = validatePath(path, workingDirectory);
        await mkdir(dirname(resolved), { recursive: true });
        await Bun.write(resolved, content);
        return `File written: ${path}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error writing file: ${message}`;
      }
    },
    {
      name: 'write_file',
      description: 'Write content to a file at the given relative path, creating parent directories as needed',
      schema: Type.Object({
        path: Type.String({ description: 'Relative path to write' }),
        content: Type.String({ description: 'Content to write to the file' }),
      }),
    },
  );
}
