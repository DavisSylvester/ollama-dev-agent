import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validatePath } from './path-validator.mts';

export function createFileWriteTool(workingDirectory: string): StructuredTool {
  return tool(
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
      schema: z.object({
        path: z.string().describe('Relative path to write'),
        content: z.string().describe('Content to write to the file'),
      }),
    },
  );
}
