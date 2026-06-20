import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { glob } from 'glob';
import { join } from 'node:path';
import { validatePath } from './path-validator.mts';

const MAX_MATCHES = 100;

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export function createGrepSearchTool(workingDirectory: string): StructuredTool {
  return tool(
    async ({
      pattern,
      path,
      file_glob,
    }: {
      pattern: string;
      path: string;
      file_glob?: string;
    }): Promise<string> => {
      try {
        const searchRoot = validatePath(path, workingDirectory);
        const filePattern = file_glob ?? '**/*';

        const files = await glob(filePattern, {
          cwd: searchRoot,
          nodir: true,
          absolute: false,
        });

        const regex = new RegExp(pattern);
        const matches: GrepMatch[] = [];

        for (const relFile of files) {
          if (matches.length >= MAX_MATCHES) break;

          const absFile = join(searchRoot, relFile);
          try {
            const file = Bun.file(absFile);
            const content = await file.text();
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= MAX_MATCHES) break;
              const lineContent = lines[i];
              if (lineContent !== undefined && regex.test(lineContent)) {
                matches.push({
                  file: relFile,
                  line: i + 1,
                  content: lineContent,
                });
              }
            }
          } catch {
            // Skip files that cannot be read (e.g. binary files)
          }
        }

        return JSON.stringify(matches);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error in grep search: ${message}`;
      }
    },
    {
      name: 'grep_search',
      description:
        'Recursively search files for a regex pattern, returning matching file, line number, and content',
      schema: z.object({
        pattern: z.string().describe('Regex pattern to search for'),
        path: z.string().default('.').describe('Directory to search in, relative to working dir'),
        file_glob: z
          .string()
          .optional()
          .describe('Glob pattern to filter files (default: **/*)')
,
      }),
    },
  );
}
