import type { StructuredTool } from '@langchain/core/tools';

export { createFileReadTool } from './file-read.mts';
export { createFileWriteTool } from './file-write.mts';
export { createFileEditTool } from './file-edit.mts';
export { createFileDeleteTool } from './file-delete.mts';
export { createListDirectoryTool } from './list-directory.mts';
export { createGlobSearchTool } from './glob-search.mts';
export { createGrepSearchTool } from './grep-search.mts';
export { createShellExecTool } from './shell-exec.mts';
export { createRunTestsTool } from './run-tests.mts';
export { createRunLinterTool } from './run-linter.mts';
export { createInstallPackageTool } from './install-package.mts';
export { createWebSearchDDGTool } from './web-search-ddg.mts';
export { createWebSearchBraveTool } from './web-search-brave.mts';

import { createFileReadTool } from './file-read.mts';
import { createFileWriteTool } from './file-write.mts';
import { createFileEditTool } from './file-edit.mts';
import { createFileDeleteTool } from './file-delete.mts';
import { createListDirectoryTool } from './list-directory.mts';
import { createGlobSearchTool } from './glob-search.mts';
import { createGrepSearchTool } from './grep-search.mts';
import { createShellExecTool } from './shell-exec.mts';
import { createRunTestsTool } from './run-tests.mts';
import { createRunLinterTool } from './run-linter.mts';
import { createInstallPackageTool } from './install-package.mts';
import { createWebSearchDDGTool } from './web-search-ddg.mts';
import { createWebSearchBraveTool } from './web-search-brave.mts';

export function createWorkerTools(
  workingDirectory: string,
  braveApiKey?: string,
): StructuredTool[] {
  return [
    createFileReadTool(workingDirectory),
    createFileWriteTool(workingDirectory),
    createFileEditTool(workingDirectory),
    createFileDeleteTool(workingDirectory),
    createListDirectoryTool(workingDirectory),
    createGlobSearchTool(workingDirectory),
    createGrepSearchTool(workingDirectory),
    createShellExecTool(workingDirectory),
    createRunTestsTool(workingDirectory),
    createRunLinterTool(workingDirectory),
    createInstallPackageTool(workingDirectory),
    createWebSearchDDGTool(),
    createWebSearchBraveTool(braveApiKey),
  ];
}
