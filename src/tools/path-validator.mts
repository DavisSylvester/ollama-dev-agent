import { resolve, relative, isAbsolute } from 'node:path';

export function validatePath(inputPath: string, workingDir: string): string {
  const resolved = resolve(workingDir, inputPath);
  const rel = relative(workingDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path '${inputPath}' is outside the working directory`);
  }
  return resolved;
}
