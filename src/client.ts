import { ApiError, NetworkError, ValidationError } from "./errors.js";
import type { ApiRequestOptions, JsonObject, JsonValue } from "./types.js";

export const DEFAULT_BASE_URL = "https://standardapi.sorftime.com/api/";

const API_MESSAGES: Record<number, string> = {
  4: "Insufficient coin balance",
  9: "Resource access is restricted",
  10: "Invalid request parameters",
  400: "Request originated from an unauthorized IP address",
  401: "This API endpoint is not enabled for the account",
  402: "The account is not authorized to view this data",
  500: "Monthly request quota has been exhausted",
  501: "Per-minute request quota has been reached",
  694: "Insufficient request balance",
};

function normalizeBaseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.endsWith("/") ? input : `${input}/`);
  } catch {
    throw new ValidationError(`Invalid base URL '${input}'.`);
  }
  if (!(["https:", "http:"] as string[]).includes(url.protocol)) {
    throw new ValidationError("Base URL must use http or https.");
  }
  return url;
}

function endpointUrl(baseUrl: string, endpoint: string, domain: number): URL {
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(endpoint)) {
    throw new ValidationError(`Invalid API endpoint '${endpoint}'.`);
  }
  const url = new URL(endpoint, normalizeBaseUrl(baseUrl));
  url.searchParams.set("domain", String(domain));
  return url;
}

function getCaseInsensitive(object: Record<string, unknown>, key: string): unknown {
  const found = Object.keys(object).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : object[found];
}

export function apiEnvelopeCode(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = getCaseInsensitive(value as Record<string, unknown>, "code");
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/u.test(raw)) return Number(raw);
  return undefined;
}

export function apiEnvelopeData(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return getCaseInsensitive(value as Record<string, unknown>, "data");
}

function apiEnvelopeMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = getCaseInsensitive(value as Record<string, unknown>, "message");
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function redactForLog(body: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      key.toLowerCase() === "image" && typeof value === "string"
        ? `[image data: ${value.length} characters]`
        : value,
    ]),
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 30_000));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.min(date - Date.now(), 30_000));
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
}

async function readResponseText(response: Response, maximumBytes?: number): Promise<string> {
  if (maximumBytes === undefined) return response.text();
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new NetworkError(`Sorftime API response exceeds the ${maximumBytes}-byte safety limit.`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new NetworkError(`Sorftime API response exceeds the ${maximumBytes}-byte safety limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function parseResponse(response: Response, maximumBytes?: number): Promise<{ value: JsonValue; raw: string; validJson: boolean }> {
  const text = await readResponseText(response, maximumBytes);
  if (!text) return { value: null, raw: text, validJson: true };
  try {
    return { value: JSON.parse(text) as JsonValue, raw: text, validJson: true };
  } catch {
    return { value: response.ok ? text : { raw: text }, raw: text, validJson: false };
  }
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const forwardAbort = (): void => controller.abort(parent?.reason);
  parent?.addEventListener("abort", forwardAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", forwardAbort);
    },
  };
}

export async function requestApi(
  options: ApiRequestOptions,
  fetchImplementation: typeof fetch = fetch,
): Promise<JsonValue> {
  const url = endpointUrl(options.baseUrl, options.endpoint, options.domain);
  const maxAttempts = options.retries + 1;

  if (options.verbose) {
    process.stderr.write(`POST ${url.toString()}\n${JSON.stringify(redactForLog(options.body))}\n`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timed = timeoutSignal(options.timeoutMs, options.signal);
    try {
      const response = await fetchImplementation(url, {
        method: "POST",
        headers: {
          Authorization: `BasicAuth ${options.token}`,
          "Content-Type": "application/json;charset=UTF-8",
          Accept: "application/json",
          "User-Agent": options.userAgent ?? "sorftime-cli/1.1.0",
        },
        body: JSON.stringify(options.body),
        signal: timed.signal,
        redirect: "error",
      });
      const parsed = await parseResponse(response, options.maxResponseBytes);
      const payload = parsed.value;

      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxAttempts) {
          const delay = parseRetryAfter(response.headers.get("retry-after")) ?? 250 * 2 ** (attempt - 1);
          await wait(delay, options.signal);
          continue;
        }
        throw new NetworkError(`Sorftime API returned HTTP ${response.status} ${response.statusText}.`, payload);
      }

      if (!parsed.validJson && !options.rawResponse) {
        throw new NetworkError("Sorftime API returned a non-JSON success response.");
      }

      const code = apiEnvelopeCode(payload);
      if (code !== undefined && code !== 0) {
        if (code === 501 && options.retryApiThrottle && attempt < maxAttempts) {
          await wait(Math.min(1000 * 2 ** (attempt - 1), 30_000), options.signal);
          continue;
        }
        const message = apiEnvelopeMessage(payload) ?? API_MESSAGES[code] ?? "Sorftime API returned a business error";
        throw new ApiError(`${message} (code ${code}).`, code, payload);
      }
      return options.rawResponse ? parsed.raw : payload;
    } catch (error) {
      if (error instanceof ApiError || error instanceof NetworkError || error instanceof ValidationError) throw error;
      if (attempt < maxAttempts && !options.signal?.aborted) {
        await wait(250 * 2 ** (attempt - 1), options.signal);
        continue;
      }
      const message = timed.signal.aborted && !options.signal?.aborted
        ? `Request timed out after ${options.timeoutMs}ms.`
        : options.signal?.aborted
          ? "Request cancelled."
          : `Unable to reach Sorftime API: ${error instanceof Error ? error.message : String(error)}`;
      throw new NetworkError(message);
    } finally {
      timed.cleanup();
    }
  }
  throw new NetworkError("Sorftime API request failed.");
}
