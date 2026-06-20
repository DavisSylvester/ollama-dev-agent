import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDDGResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Match result blocks: each result is wrapped in a <div class="result ..."> block
  const resultBlockRegex = /<div[^>]+class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1] ?? '';

    // Extract title and URL from anchor tag
    const anchorRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
    const anchorMatch = anchorRegex.exec(block);

    // Extract snippet from result__snippet span
    const snippetRegex = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/;
    const snippetMatch = snippetRegex.exec(block);

    if (anchorMatch) {
      const rawUrl = anchorMatch[1] ?? '';
      const rawTitle = anchorMatch[2] ?? '';
      const rawSnippet = snippetMatch ? (snippetMatch[1] ?? '') : '';

      const url = rawUrl.trim();
      const title = rawTitle.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").trim();
      const snippet = rawSnippet.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").trim();

      if (title && url && !url.startsWith('//duckduckgo')) {
        results.push({ title, url, snippet });
      }
    }
  }

  return results;
}

export function createWebSearchDDGTool(): StructuredTool {
  return tool(
    async ({
      query,
      max_results,
    }: {
      query: string;
      max_results: number;
    }): Promise<string> => {
      try {
        const encoded = encodeURIComponent(query);
        const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

        const response = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml',
          },
        });

        if (!response.ok) {
          return `Error fetching search results: HTTP ${response.status}`;
        }

        const html = await response.text();
        const results = parseDDGResults(html, max_results);

        return JSON.stringify(results);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error in web search: ${message}`;
      }
    },
    {
      name: 'web_search_ddg',
      description: 'Search the web using DuckDuckGo and return titles, URLs, and snippets',
      schema: z.object({
        query: z.string().describe('Search query'),
        max_results: z.number().default(5).describe('Maximum number of results to return'),
      }),
    },
  );
}
