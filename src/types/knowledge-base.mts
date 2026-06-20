// Categories the global knowledge base is grouped by.
export type KBCategory = 'ui' | 'api' | 'database' | 'auth';

export interface KBMetadata {
  taskId?: string;
  iterations?: number;
  status?: string;
  timestamp?: string;
  [key: string]: unknown;
}

// A single learned issue → resolution record.
export interface KBEntry {
  issue: string;
  prompt: string;
  model?: string;
  resolution: string;
  metadata: KBMetadata;
}

// The full knowledge base: entries grouped by category.
export type KnowledgeBase = Record<KBCategory, KBEntry[]>;
