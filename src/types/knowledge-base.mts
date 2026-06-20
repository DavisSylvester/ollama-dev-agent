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
//
// actual_*      — concrete, run-specific text (the exact task and the exact fix).
// generalized_* — project-agnostic version of the same, written so the lesson
//                 transfers to other runs/projects facing the same class of issue.
export interface KBEntry {
  issue: string;
  actual_prompt: string;
  actual_resolution: string;
  generalized_prompt: string;
  generalized_resolution: string;
  model?: string;
  metadata: KBMetadata;
}

// The full knowledge base: entries grouped by category.
export type KnowledgeBase = Record<KBCategory, KBEntry[]>;
