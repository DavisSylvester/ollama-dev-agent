import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validatePath } from './path-validator.mts';

interface DirectoryEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

export function createListDirectoryTool(workingDirectory: string): StructuredTool {
  return tool(
    async ({ path }: { path: string }): Promise<string> => {
      try {
        const resolved = validatePath(path, workingDirectory);
        const entries = await readdir(resolved);

        const results: DirectoryEntry[] = await Promise.all(
          entries.map(async (name): Promise<DirectoryEntry> => {
            const fullPath = join(resolved, name);
            try {
              const info = await stat(fullPath);
              if (info.isDirectory()) {
                return { name, type: 'directory' };
              }
              return { name, type: 'file', size: info.size };
            } catch {
              return { name, type: 'file' };
            }
          }),
        );

        return JSON.stringify(results);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error listing directory: ${message}`;
      }
    },
    {
      name: 'list_directory',
      description: 'List the contents of a directory, returning name, type, and size for each entry',
      schema: z.object({
        path: z
          .string()
          .default('.')
          .describe('Directory path relative to working dir'),
      }),
    },
  );
}
