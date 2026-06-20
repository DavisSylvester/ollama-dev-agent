import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export function createWebSearchBraveTool(apiKey: string | undefined): StructuredTool {
  return tool(
    async ({
      query,
      max_results,
    }: {
      query: string;
      max_results: number;
    }): Promise<string> => {
      if (!apiKey) {
        return 'Brave Search requires BRAVE_API_KEY environment variable';
      }

      try {
        const encoded = encodeURIComponent(query);
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encoded}&count=${max_results}`;

        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': apiKey,
          },
        });

        if (!response.ok) {
          return `Error fetching Brave search results: HTTP ${response.status}`;
        }

        const data = await response.json() as BraveSearchResponse;
        const rawResults = data.web?.results ?? [];

        const results: SearchResult[] = rawResults
          .slice(0, max_results)
          .map((r: BraveWebResult) => ({
            title: r.title ?? '',
            url: r.url ?? '',
            snippet: r.description ?? '',
          }));

        return JSON.stringify(results);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error in Brave web search: ${message}`;
      }
    },
    {
      name: 'web_search_brave',
      description: 'Search the web using Brave Search API and return titles, URLs, and snippets',
      schema: z.object({
        query: z.string().describe('Search query'),
        max_results: z.number().default(5).describe('Maximum number of results to return'),
      }),
    },
  );
}
