import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createChatModel } from '../models/index.mts';
import { HumanMessage, SystemMessage, type AIMessage } from '@langchain/core/messages';
import { env } from '../env.mts';
import { logger } from '../logger.mts';
import { buildDocSummaryPrompt } from './prompts.mts';

export interface DocSummary {
  relPath: string;
  summary: string;
}

export interface SummarizeDeps {
  invokeFn?: (systemPrompt: string, userPrompt: string) => Promise<string>;
  onProgress?: (done: number, total: number, relPath: string) => void;
  cacheDir?: string;
  maxContentChars?: number;
}

function extractContent(aiMessage: AIMessage): string {
  const content = aiMessage.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === 'string'
          ? b
          : typeof b === 'object' && b !== null && 'text' in b && typeof (b as { text: unknown }).text === 'string'
            ? (b as { text: string }).text
            : '',
      )
      .join('');
  }
  return String(content);
}

async function defaultInvoke(systemPrompt: string, userPrompt: string): Promise<string> {
  const model = createChatModel(env.PLANNER_MODEL);
  const res = (await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ])) as AIMessage;
  return extractContent(res);
}

const SUMMARY_USER_PROMPT = 'Summarize the document above.';

// ~4 chars/token; halve NUM_CTX to leave room for the summary prompt itself.
function defaultMaxContentChars(): number {
  return Math.floor(env.NUM_CTX * 4 * 0.5);
}

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function readCache(cacheDir: string, key: string): Promise<string> {
  try {
    return (await readFile(join(cacheDir, `${key}.md`), 'utf-8')).trim();
  } catch {
    return '';
  }
}

async function writeCache(cacheDir: string, key: string, summary: string): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `${key}.md`), summary, 'utf-8');
  } catch (err) {
    logger.warn({ cacheDir, err: err instanceof Error ? err.message : String(err) }, 'docs.cache_write_failed');
  }
}

// Map: one summary per file. Reads content, summarizes (chunking oversized
// files), caches by content hash. Read/summarize failures are logged and skipped.
export async function summarizeDocs(
  docsDir: string,
  files: readonly string[],
  deps?: SummarizeDeps,
): Promise<DocSummary[]> {
  const invoke = deps?.invokeFn ?? defaultInvoke;
  const maxChars = deps?.maxContentChars ?? defaultMaxContentChars();
  const summaries: DocSummary[] = [];
  let done = 0;

  for (const file of files) {
    const relPath = relative(docsDir, file).replace(/\\/g, '/');
    let content = '';
    try {
      content = await readFile(file, 'utf-8');
    } catch (err) {
      logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'docs.read_failed');
      done++;
      deps?.onProgress?.(done, files.length, relPath);
      continue;
    }

    const key = createHash('sha256').update(`${relPath} ${content}`).digest('hex');
    let summary = deps?.cacheDir ? await readCache(deps.cacheDir, key) : '';

    if (summary.length === 0) {
      try {
        if (content.length <= maxChars) {
          summary = (await invoke(buildDocSummaryPrompt(relPath, content), SUMMARY_USER_PROMPT)).trim();
        } else {
          const parts = chunk(content, maxChars);
          const partSummaries: string[] = [];
          for (let i = 0; i < parts.length; i++) {
            const label = `${relPath} (part ${i + 1}/${parts.length})`;
            partSummaries.push((await invoke(buildDocSummaryPrompt(label, parts[i]!), SUMMARY_USER_PROMPT)).trim());
          }
          summary = partSummaries.filter((s) => s.length > 0).join('\n\n');
        }
      } catch (err) {
        logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'docs.summarize_failed');
      }
      if (summary.length > 0 && deps?.cacheDir) await writeCache(deps.cacheDir, key, summary);
    }

    if (summary.length > 0) summaries.push({ relPath, summary });
    done++;
    deps?.onProgress?.(done, files.length, relPath);
  }

  return summaries;
}

function totalChars(summaries: readonly DocSummary[]): number {
  return summaries.reduce((n, s) => n + s.summary.length, 0);
}

// Fold: if the combined summaries exceed the budget, group them into batches
// under the budget and summarize each batch into one merged DocSummary.
export async function reduceSummaries(
  summaries: DocSummary[],
  deps?: SummarizeDeps,
): Promise<DocSummary[]> {
  const maxChars = deps?.maxContentChars ?? defaultMaxContentChars();
  if (totalChars(summaries) <= maxChars) return summaries;

  const invoke = deps?.invokeFn ?? defaultInvoke;
  // Distribute into just enough groups to fit the budget, evenly by count, so
  // the fold reliably reduces the number of summaries.
  const groups = Math.max(1, Math.ceil(totalChars(summaries) / maxChars));
  const perGroup = Math.max(1, Math.ceil(summaries.length / groups));
  const batches: DocSummary[][] = [];
  for (let i = 0; i < summaries.length; i += perGroup) {
    batches.push(summaries.slice(i, i + perGroup));
  }

  const merged: DocSummary[] = [];
  for (let i = 0; i < batches.length; i++) {
    const joined = batches[i]!.map((s) => `### ${s.relPath}\n${s.summary}`).join('\n\n');
    const summary = (await invoke(buildDocSummaryPrompt(`merged-group-${i + 1}`, joined), SUMMARY_USER_PROMPT)).trim();
    merged.push({ relPath: `merged-group-${i + 1}`, summary: summary.length > 0 ? summary : joined });
  }
  return merged;
}
