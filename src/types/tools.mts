export interface ToolResult<T = string> {
  readonly ok: true;
  readonly value: T;
}

export interface ToolError {
  readonly ok: false;
  readonly error: string;
}

export type ToolResponse<T = string> = ToolResult<T> | ToolError;

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size?: number;
}

export interface GrepMatch {
  readonly file: string;
  readonly line: number;
  readonly content: string;
}
