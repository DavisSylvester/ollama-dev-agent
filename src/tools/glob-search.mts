import { Type } from '@sinclair/typebox';
import type { StructuredTool } from '@langchain/core/tools';
import { defineTool } from './define-tool.mts';
import { glob } from 'glob';

const MAX_RESULTS = 200;

export function createGlobSearchTool(workingDirectory: string): StructuredTool {
  return defineTool(
    async ({
      pattern,
      ignore,
    }: {
      pattern: string;
      ignore?: string[];
    }): Promise<string> => {
      try {
        const matches = await glob(pattern, {
          cwd: workingDirectory,
          ignore: ignore ?? [],
          nodir: false,
          absolute: false,
        });

        const limited = matches
          .slice(0, MAX_RESULTS)
          .map((p) => p.replace(/\\/g, '/'));
        return limited.join('\n');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error in glob search: ${message}`;
      }
    },
    {
      name: 'glob_search',
      description: 'Search for files matching a glob pattern within the working directory',
      schema: Type.Object({
        pattern: Type.String({ description: 'Glob pattern like **/*.ts' }),
        ignore: Type.Optional(
          Type.Array(Type.String(), { description: 'Optional list of glob patterns to ignore' }),
        ),
      }),
    },
  );
}
