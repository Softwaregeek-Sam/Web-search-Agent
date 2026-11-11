import { errFields, type Logger } from "../logger.js";
import {
  MAX_SEARCH_RESULTS,
  type SearchProvider,
  type SearchRequest,
  type SearchResult,
  normalizeSearchResults,
} from "./provider.js";

export class SearchProviderError extends Error {
  readonly attempts: number;
  readonly cause: unknown;

  constructor(message: string, attempts: number, cause: unknown) {
    super(message);
    this.name = "SearchProviderError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

export interface ResilientSearchOptions {
  logger?: Logger;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export function createResilientSearchProvider(provider: SearchProvider, options: ResilientSearchOptions = {}): SearchProvider {
  const logger = options.logger;
  const retryDelayMs = options.retryDelayMs ?? 0;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  return {
    async search(request: SearchRequest): Promise<SearchResult[]> {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          return normalizeSearchResults((await provider.search(request)).slice(0, MAX_SEARCH_RESULTS));
        } catch (error) {
          lastError = error;
          if (attempt === 1) {
            logger?.warn("search.retry", { attempt, ...errFields(error) });
            if (retryDelayMs > 0) await sleep(retryDelayMs);
            continue;
          }
          logger?.error("search.failed", { attempts: attempt, ...errFields(error) });
        }
      }
      throw new SearchProviderError("Search provider failed after one retry", 2, lastError);
    },
  };
}
