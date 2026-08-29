import { describe, expect, it, vi } from "vitest";
import { apiEnvelopeCode, apiEnvelopeData, requestApi } from "../src/client.js";
import { ApiError, NetworkError } from "../src/errors.js";

const options = {
  endpoint: "CoinQuery",
  domain: 7,
  body: {},
  token: "sentinel-secret-never-real",
  baseUrl: "https://example.test/api/",
  timeoutMs: 1_000,
  retries: 0,
};

describe("Sorftime client", () => {
  it("constructs the canonical POST request and exact auth scheme", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ Code: 0, Data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await requestApi(options, fetchMock);
    expect(result).toEqual({ Code: 0, Data: { ok: true } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://example.test/api/CoinQuery?domain=7");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("BasicAuth sentinel-secret-never-real");
    expect(init?.body).toBe("{}");
  });

  it("reads both camelCase and PascalCase envelopes", () => {
    expect(apiEnvelopeCode({ Code: 0 })).toBe(0);
    expect(apiEnvelopeCode({ code: "501" })).toBe(501);
    expect(apiEnvelopeData({ DATA: [1, 2] })).toEqual([1, 2]);
  });

  it("raises a typed business error without retrying", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 10, message: "bad input" }), { status: 200 }),
    );
    await expect(requestApi(options, fetchMock)).rejects.toMatchObject({ apiCode: 10, exitCode: 5 } satisfies Partial<ApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("raises a transport error for non-2xx responses", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "nope" }), { status: 403, statusText: "Forbidden" }),
    );
    await expect(requestApi(options, fetchMock)).rejects.toBeInstanceOf(NetworkError);
    const logged = stderr.mock.calls.flat().join("");
    expect(logged).toContain('"event":"sorftime_http_error"');
    expect(logged).toContain('"endpoint":"CoinQuery"');
    expect(logged).toContain('"status":403');
    expect(logged).not.toContain("nope");
    expect(logged).not.toContain(options.token);
    stderr.mockRestore();
  });

  it("rejects non-JSON success responses unless exact raw output is requested", async () => {
    const html = "<html>proxy login</html>";
    const invalidJson = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status: 200 }));
    await expect(requestApi(options, invalidJson)).rejects.toMatchObject({
      message: "Sorftime API returned a non-JSON success response.",
    });
    const rawFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(` {"Code":0}\n`, { status: 200 }));
    await expect(requestApi({ ...options, rawResponse: true }, rawFetch)).resolves.toBe(` {"Code":0}\n`);
  });

  it("retries business throttle code 501 only when explicitly enabled", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Code: 501 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Code: 0, Data: [] }), { status: 200 }));
    const promise = requestApi({ ...options, retries: 1, retryApiThrottle: true }, fetchMock);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toEqual({ Code: 0, Data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("redacts image bodies from verbose diagnostics", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ Code: 0 }), { status: 200 }));
    await requestApi({ ...options, endpoint: "SimilarProductRealtimeRequest", body: { Image: "secret-image-payload" }, verbose: true }, fetchMock);
    const logged = stderr.mock.calls.flat().join("");
    expect(logged).toContain("[image data:");
    expect(logged).not.toContain("secret-image-payload");
    expect(logged).not.toContain(options.token);
    stderr.mockRestore();
  });
});
