import { Type } from '@sinclair/typebox';
import type { StructuredTool } from '@langchain/core/tools';
import { defineTool } from './define-tool.mts';
import { validatePath } from './path-validator.mts';

export function createFileEditTool(workingDirectory: string): StructuredTool {
  return defineTool(
    async ({
      path,
      old_text,
      new_text,
    }: {
      path: string;
      old_text: string;
      new_text: string;
    }): Promise<string> => {
      try {
        const resolved = validatePath(path, workingDirectory);
        const file = Bun.file(resolved);
        const exists = await file.exists();
        if (!exists) {
          return `Error editing file: File not found: ${path}`;
        }
        const original = await file.text();
        if (!original.includes(old_text)) {
          return 'Text not found in file';
        }
        const updated = original.replace(old_text, () => new_text);
        await Bun.write(resolved, updated);
        return `File edited: ${path}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error editing file: ${message}`;
      }
    },
    {
      name: 'edit_file',
      description: 'Replace the first occurrence of exact text in a file with new text',
      schema: Type.Object({
        path: Type.String({ description: 'Relative path to the file to edit' }),
        old_text: Type.String({ description: 'Exact text to replace' }),
        new_text: Type.String({ description: 'Replacement text' }),
      }),
    },
  );
}
