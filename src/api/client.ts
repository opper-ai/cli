import { OpperError } from "../errors.js";

export interface OpperApiConfig {
  baseUrl: string;
  apiKey: string;
  projectUuid?: string | undefined;
}

interface ErrorBody {
  // `error` is an object on most surfaces ({message, type}) but a bare string
  // on some (e.g. POST /v3/images' validation 400s). Without the string arm we
  // fall through to printing the raw JSON body at the user.
  error?: { message?: string; type?: string; code?: string } | string;
  detail?: string;
  message?: string;
  code?: string;
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

  async patch<T>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const res = await this.fetch(url, {
      method: "PATCH",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    return this.parseJson<T>(res);
  }

  async postMultipart<T>(path: string, form: FormData): Promise<T> {
    const url = this.buildUrl(path);
    // No Content-Type header — fetch derives the multipart boundary.
    const res = await this.fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: form,
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
    yield* this.readSse(res);
  }

  /** SSE over GET — long-lived server push streams (e.g. app logs). */
  async *streamGet(path: string): AsyncIterable<string> {
    const url = this.buildUrl(path);
    const res = await this.fetch(url, {
      method: "GET",
      headers: this.headers({ Accept: "text/event-stream" }),
    });
    yield* this.readSse(res);
  }

  private async *readSse(res: Response): AsyncIterable<string> {
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
        if (line.startsWith("data:")) {
          const payload = line.slice(5).replace(/^\s/, "");
          if (payload === "[DONE]") return;
          yield payload;
        }
      }
    }
    if (buffer.startsWith("data:")) {
      const payload = buffer.slice(5).replace(/^\s/, "");
      if (payload && payload !== "[DONE]") yield payload;
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
      ...(this.config.projectUuid ? { "X-Opper-Project": this.config.projectUuid } : {}),
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
      const expired = res.headers.get("X-Opper-Error-Code") === "credential_expired";
      throw new OpperError(
        "AUTH_EXPIRED",
        expired ? "API key expired." : "API key was rejected by the server.",
        expired
          ? "Run `opper login --renew` to obtain a replacement credential."
          : "Check account access or replace the stored key, then retry.",
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
    const err = body?.error;
    const errMessage = typeof err === "string" ? err : err?.message;
    if (res.headers.get("X-Opper-Error-Code") === "project_required" || body?.code === "project_required" ||
        (typeof err === "object" && (err?.type === "project_required" || err?.code === "project_required"))) {
      throw new OpperError("PROJECT_REQUIRED", "This command requires a project.",
        "Pass --project-uuid <uuid>, or set a resource default with `opper config project <slot> <uuid>`.");
    }
    const detail = errMessage ?? body?.detail ?? body?.message ?? text;
    throw new OpperError(
      "API_ERROR",
      `HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
}
