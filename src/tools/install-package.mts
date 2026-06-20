import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { execa } from 'execa';

export function createInstallPackageTool(workingDirectory: string): StructuredTool {
  return tool(
    async ({
      packages,
      dev,
    }: {
      packages: string[];
      dev: boolean;
    }): Promise<string> => {
      try {
        const args = ['add'];
        if (dev) {
          args.push('--dev');
        }
        args.push(...packages);

        const proc = await execa('bun', args, {
          cwd: workingDirectory,
          reject: false,
          all: true,
        });

        const output = proc.all ?? `${proc.stdout}\n${proc.stderr}`.trim();
        return output;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error installing packages: ${message}`;
      }
    },
    {
      name: 'install_package',
      description: 'Install one or more npm packages using `bun add`, optionally as dev dependencies',
      schema: z.object({
        packages: z.array(z.string()).describe('Package names to install'),
        dev: z.boolean().default(false).describe('Install as dev dependencies'),
      }),
    },
  );
}
