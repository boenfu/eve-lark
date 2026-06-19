/**
 * Minimal mock fetch for tests. Each registered handler matches every request
 * that satisfies its (method, path, optional body/header matchers). Handlers
 * are tried in registration order; the first match wins. Handlers are
 * persistent (reusable across calls) — tests use closure counters to assert
 * call counts.
 *
 * The `pendingCount`/`pendingDescriptions` helpers report handlers that have
 * never matched, so tests can fail loudly when an expected call never happened.
 */

export interface MockRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type MockHandler = (req: MockRequest) => MockResponse | Promise<MockResponse>;

interface RegisteredHandler {
  method: string;
  pathMatcher: (url: URL) => boolean;
  bodyMatcher?: (body: unknown) => boolean;
  headerMatcher?: (headers: Record<string, string>) => boolean;
  handler: MockHandler;
  description: string;
  matched: number;
}

export interface MockFetch {
  fetch: typeof fetch;
  on(
    method: string,
    path: string | ((url: URL) => boolean),
    handler: MockHandler,
    opts?: {
      bodyMatcher?: (body: unknown) => boolean;
      headerMatcher?: (headers: Record<string, string>) => boolean;
      description?: string;
    },
  ): void;
  pendingCount(): number;
  pendingDescriptions(): string[];
}

export function createMockFetch(): MockFetch {
  const handlers: RegisteredHandler[] = [];

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const rawHeaders: Record<string, string> = {};
    if (init?.headers) {
      const entries =
        init.headers instanceof Headers
          ? Array.from(init.headers.entries())
          : Array.isArray(init.headers)
            ? init.headers
            : Object.entries(init.headers);
      for (const [k, v] of entries) {
        rawHeaders[k.toLowerCase()] = String(v);
      }
    }
    let body: unknown = undefined;
    if (init?.body !== undefined && init.body !== null) {
      let raw: string;
      if (typeof init.body === "string") {
        raw = init.body;
      } else if (init.body instanceof Uint8Array) {
        raw = new TextDecoder().decode(init.body);
      } else {
        raw = String(init.body);
      }
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }

    const h = handlers.find((hh) => {
      if (hh.method !== method) return false;
      if (!hh.pathMatcher(url)) return false;
      if (hh.headerMatcher && !hh.headerMatcher(rawHeaders)) return false;
      if (hh.bodyMatcher && !hh.bodyMatcher(body)) return false;
      return true;
    });
    if (!h) {
      throw new Error(`mock-fetch: no handler for ${method} ${url.toString()}`);
    }
    h.matched += 1;
    const result = await h.handler({ method, url, headers: rawHeaders, body });
    return new Response(
      result.body === undefined
        ? ""
        : typeof result.body === "string"
          ? result.body
          : JSON.stringify(result.body),
      {
        status: result.status,
        headers: new Headers(result.headers),
      },
    );
  }) as unknown as typeof fetch;

  const on: MockFetch["on"] = (method, path, handler, opts = {}) => {
    const pathMatcher =
      typeof path === "string"
        ? (url: URL) => url.pathname.startsWith(path)
        : path;
    handlers.push({
      method,
      pathMatcher,
      bodyMatcher: opts.bodyMatcher,
      headerMatcher: opts.headerMatcher,
      handler,
      description: opts.description ?? `${method} ${typeof path === "string" ? path : "<fn>"}`,
      matched: 0,
    });
  };

  return {
    fetch: fetchFn,
    on,
    pendingCount: () => handlers.filter((h) => h.matched === 0).length,
    pendingDescriptions: () =>
      handlers.filter((h) => h.matched === 0).map((h) => h.description),
  };
}
