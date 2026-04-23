import config from "../config.js";
import { createApiError } from "../middleware/error.js";

const DEFAULT_TIMEOUT_MS = 15_000;

type HttpMethod = "GET" | "POST";

export interface LpAgentRequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  timeoutMs?: number;
}

class LpAgentService {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor() {
    this.baseUrl = config.LP_AGENT_BASE_URL.replace(/\/$/, "");
    this.apiKey = config.LP_AGENT_API_KEY;
    this.timeoutMs = config.LP_AGENT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private buildUrl(path: string, query?: LpAgentRequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    options: LpAgentRequestOptions = {}
  ): Promise<T> {
    if (!this.apiKey) {
      throw createApiError("LP Agent API key not configured", 503);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.timeoutMs
    );

    try {
      const res = await fetch(this.buildUrl(path, options.query), {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        // NEVER echo upstream response bodies — they may contain the API key
        // (some servers echo the request header back) or other sensitive data.
        // Status code is the only safe artifact to surface to callers.
        throw createApiError(
          `LP Agent request failed (${res.status})`,
          res.status >= 500 ? 503 : 502
        );
      }

      return (await res.json()) as T;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw createApiError("LP Agent request timed out", 504);
      }
      if ((err as { statusCode?: number }).statusCode) {
        throw err;
      }
      // Generic message to client; full error available server-side via the
      // global error handler's logger.error() call.
      throw createApiError("LP Agent request error", 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  discoverPools(query: Record<string, string | number | boolean | undefined>) {
    return this.request<unknown>("GET", "/pools/discover", { query });
  }

  getPoolInfo(poolId: string) {
    return this.request<unknown>("GET", `/pools/${poolId}/info`);
  }

  generateAddTx(poolId: string, body: Record<string, unknown>) {
    return this.request<unknown>("POST", `/pools/${poolId}/add-tx`, { body });
  }

  landingAddTx(body: Record<string, unknown>) {
    return this.request<unknown>("POST", "/pools/landing-add-tx", { body });
  }

  getOpeningPositions(owner: string, pageSize?: number) {
    return this.request<unknown>("GET", "/lp-positions/opening", {
      query: {
        owner,
        pageSize,
      },
    });
  }

  decreaseQuotes(body: Record<string, unknown>) {
    return this.request<unknown>("POST", "/position/decrease-quotes", { body });
  }

  decreaseTx(body: Record<string, unknown>) {
    return this.request<unknown>("POST", "/position/decrease-tx", { body });
  }

  landingDecreaseTx(body: Record<string, unknown>) {
    return this.request<unknown>("POST", "/position/landing-decrease-tx", { body });
  }
}

export const lpAgentService = new LpAgentService();
