/**
 * 替换全局 fetch 的测试替身：按 URL 子串匹配预设响应，并记录所有出站请求。
 * 用它验证「重试几次」「失败怎么降级」「请求体长什么样」这类行为。
 */

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

export interface FetchStub {
  calls: RecordedCall[];
  /** URL 含 pattern 时用 handler 响应；后注册的优先。 */
  on(pattern: string, handler: Handler): void;
  onJson(pattern: string, payload: unknown, status?: number): void;
  onError(pattern: string, message?: string): void;
  restore(): void;
  /** 匹配 pattern 的调用次数。 */
  countFor(pattern: string): number;
}

export function stubFetch(): FetchStub {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  const handlers: Array<{ pattern: string; handler: Handler }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
    const call: RecordedCall = {
      url,
      method: String(init?.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    for (let i = handlers.length - 1; i >= 0; i -= 1) {
      if (url.includes(handlers[i]!.pattern)) return handlers[i]!.handler(call);
    }
    throw new Error(`测试未预设该请求：${url}`);
  }) as typeof fetch;

  return {
    calls,
    on(pattern, handler) {
      handlers.push({ pattern, handler });
    },
    onJson(pattern, payload, status = 200) {
      handlers.push({
        pattern,
        handler: () =>
          new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }),
      });
    },
    onError(pattern, message = 'network down') {
      handlers.push({
        pattern,
        handler: () => {
          throw new Error(message);
        },
      });
    },
    countFor(pattern) {
      return calls.filter((call) => call.url.includes(pattern)).length;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}
