import { OpperError } from "../errors.js";

export interface OpperApiConfig {
  baseUrl: string;
  apiKey: string;
}

interface ErrorBody {
  error?: { message?: string; type?: string };
  detail?: string;
  message?: string;
}

export class OpperApi {
  constructor(private readonly config: OpperApiConfig) {}

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = this.buildUrl(path, query);
    const res = await this.fetch(url, { method: "GET", headers: this.headers() });
    return this.parseJson<T>(res);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const res = await this.fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    return this.parseJson<T>(res);
  }

  async del(path: string): Promise<void> {
    const url = this.buildUrl(path);
    const res = await this.fetch(url, { method: "DELETE", headers: this.headers() });
    if (res.status === 204) return;
    if (!res.ok) await this.throwApiError(res);
  }

  async *stream(path: string, body: unknown): AsyncIterable<string> {
    const url = this.buildUrl(path);
    const res = await this.fetch(url, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      }),
      body: JSON.stringify(body),
    });
    if (!res.ok) await this.throwApiError(res);
    if (!res.body) return;

    const decoder = new TextDecoder();
    let buffer = "";
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (payload === "[DONE]") return;
          yield payload;
        }
      }
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const base = this.config.baseUrl.replace(/\/$/, "");
    const url = new URL(base + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      ...extra,
    };
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (err) {
      throw new OpperError(
        "NETWORK_ERROR",
        `Network request failed: ${err instanceof Error ? err.message : String(err)}`,
        "Check your internet connection and try again.",
      );
    }
  }

  private async parseJson<T>(res: Response): Promise<T> {
    if (!res.ok) await this.throwApiError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async throwApiError(res: Response): Promise<never> {
    if (res.status === 401) {
      throw new OpperError(
        "AUTH_EXPIRED",
        "API key was rejected by the server.",
        "Run `opper login --force` to re-authenticate.",
      );
    }
    let body: ErrorBody | null = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text) as ErrorBody;
      } catch {
        /* leave body null */
      }
    }
    const detail = body?.error?.message ?? body?.detail ?? body?.message ?? text;
    throw new OpperError(
      "API_ERROR",
      `HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
}
