import { apiEnvelopeData, DEFAULT_BASE_URL } from "./client.js";
import { loadConfig, resolveToken } from "./config.js";
import { SorftimeCoreClient } from "./core/service.js";
import { resolveDomain } from "./domains.js";
import { AuthenticationError, ValidationError } from "./errors.js";
import { buildRequestBody } from "./input.js";
import { writeOutput } from "./output.js";
import type { EndpointSpec, GlobalOptions, JsonObject, JsonValue, OutputFormat } from "./types.js";

const OUTPUT_FORMATS: readonly OutputFormat[] = ["json", "jsonl", "yaml", "csv", "table", "raw"];
const HISTORY_FIELDS: Record<string, readonly string[] | "always"> = {
  CategoryRequest: ["QueryStart", "QueryDate", "QueryDays"],
  CategoryTrend: "always",
  ProductRequest: ["QueryTrendStartDt", "QueryTrendEndDt"],
  AsinSalesVolume: ["QueryDate", "QueryEndDate"],
  KeywordSearchResultTrend: ["QueryStart", "QueryEnd"],
  KeywordProductRanking: ["Month"],
  ASINKeywordRanking: ["QueryStart", "QueryEnd"],
};

function integerOption(value: string | number | undefined, fallback: number, label: string, min: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidationError(`${label} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function outputFormat(value: string | undefined, fallback: OutputFormat): OutputFormat {
  const selected = value ?? fallback;
  if (!OUTPUT_FORMATS.includes(selected as OutputFormat)) {
    throw new ValidationError(`Output format must be one of: ${OUTPUT_FORMATS.join(", ")}.`);
  }
  return selected as OutputFormat;
}

function validateBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ValidationError(`Invalid base URL '${baseUrl}'.`);
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ValidationError("Base URL must use HTTPS (HTTP is accepted only for localhost testing). ");
  }
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function requestsHistory(endpoint: EndpointSpec, body: JsonObject): boolean {
  const fields = HISTORY_FIELDS[endpoint.name];
  return fields === "always" || fields?.some((field) => body[field] !== undefined) === true;
}

interface RowLocation {
  rows: JsonValue[];
  dataKey?: string;
  childKey?: string;
  rootArray?: boolean;
}

function caseInsensitiveKey(object: Record<string, JsonValue>, expected: string): string | undefined {
  return Object.keys(object).find((key) => key.toLowerCase() === expected.toLowerCase());
}

function locateRows(payload: JsonValue): RowLocation | undefined {
  if (Array.isArray(payload)) return { rows: payload, rootArray: true };
  if (!payload || typeof payload !== "object") return undefined;
  const envelope = payload as Record<string, JsonValue>;
  const dataKey = caseInsensitiveKey(envelope, "data");
  const data = apiEnvelopeData(payload) as JsonValue | undefined;
  if (Array.isArray(data)) return { rows: data, ...(dataKey ? { dataKey } : {}) };
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;

  const dataObject = data as Record<string, JsonValue>;
  const preferred = ["items", "list", "rows", "records", "results", "products", "keywords"];
  const childKey = preferred
    .map((name) => caseInsensitiveKey(dataObject, name))
    .find((key) => key !== undefined && Array.isArray(dataObject[key]));
  const arrayKeys = Object.keys(dataObject).filter((key) => Array.isArray(dataObject[key]));
  const selected = childKey ?? (arrayKeys.length === 1 ? arrayKeys[0] : undefined);
  if (!selected || !dataKey) return undefined;
  return { rows: dataObject[selected] as JsonValue[], dataKey, childKey: selected };
}

function aggregatePages(first: JsonValue, location: RowLocation, rows: JsonValue[], pagesFetched: number, startPage: number, capped: boolean): JsonValue {
  if (location.rootArray) return rows;
  if (!first || typeof first !== "object" || Array.isArray(first) || !location.dataKey) return rows;
  const envelope = { ...(first as Record<string, JsonValue>) };
  if (location.childKey) {
    const data = envelope[location.dataKey];
    envelope[location.dataKey] = {
      ...((data && typeof data === "object" && !Array.isArray(data)) ? data : {}),
      [location.childKey]: rows,
    };
  } else {
    envelope[location.dataKey] = rows;
  }
  envelope._pagination = { pagesFetched, startPage, maxPagesReached: capped };
  return envelope;
}

async function pageDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Interrupted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestAllPages(
  endpoint: EndpointSpec,
  baseBody: JsonObject,
  requestPage: (body: JsonObject) => Promise<JsonValue>,
  maxPages: number,
  delayMs: number,
  signal?: AbortSignal,
  verbose?: boolean,
): Promise<JsonValue> {
  const pagination = endpoint.pagination;
  if (!pagination) throw new ValidationError(`Endpoint ${endpoint.name} does not have a documented safe pagination strategy.`);
  const startPageValue = baseBody[pagination.pageKey];
  const startPage = typeof startPageValue === "number" ? startPageValue : 1;
  const requestedSize = pagination.pageSizeKey && typeof baseBody[pagination.pageSizeKey] === "number"
    ? baseBody[pagination.pageSizeKey] as number
    : pagination.defaultPageSize;

  let first: JsonValue | undefined;
  let firstLocation: RowLocation | undefined;
  const allRows: JsonValue[] = [];
  let pagesFetched = 0;
  let lastPageWasFull = false;

  for (let offset = 0; offset < maxPages; offset += 1) {
    const pageNumber = startPage + offset;
    if (offset > 0) await pageDelay(delayMs, signal);
    if (verbose) process.stderr.write(`Fetching page ${pageNumber} of ${endpoint.name}\n`);
    const payload = await requestPage({ ...baseBody, [pagination.pageKey]: pageNumber });
    const located = locateRows(payload);
    if (!located) {
      throw new ValidationError(`Could not identify a result array in page ${pageNumber}; rerun without --all-pages.`);
    }
    first ??= payload;
    firstLocation ??= located;
    pagesFetched += 1;
    allRows.push(...located.rows);
    lastPageWasFull = located.rows.length >= requestedSize;
    if (located.rows.length < requestedSize) break;
  }

  if (first === undefined || firstLocation === undefined) throw new ValidationError("Pagination returned no response.");
  return aggregatePages(first, firstLocation, allRows, pagesFetched, startPage, pagesFetched === maxPages && lastPageWasFull);
}

export async function runEndpoint(
  endpoint: EndpointSpec,
  commandOptions: Record<string, unknown>,
  globalOptions: GlobalOptions,
  signal?: AbortSignal,
): Promise<void> {
  const config = await loadConfig();
  const tokenResult = await resolveToken(globalOptions.token);
  if (!tokenResult.token) {
    throw new AuthenticationError("No Account-SK configured. Run 'sorftime auth login' or set SORFTIME_ACCOUNT_SK.");
  }

  const domain = resolveDomain(globalOptions.domain ?? process.env.SORFTIME_DOMAIN ?? config.domain);
  const body = await buildRequestBody(endpoint, commandOptions);
  if (!domain.historyBackfill && requestsHistory(endpoint, body) && !globalOptions.force) {
    throw new ValidationError(
      `${domain.code} does not support historical backfill for this endpoint. Omit historical fields or pass --force to send anyway.`,
    );
  }

  const baseUrl = validateBaseUrl(globalOptions.baseUrl ?? process.env.SORFTIME_BASE_URL ?? config.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutSeconds = globalOptions.timeout ?? process.env.SORFTIME_TIMEOUT;
  const timeoutMs = timeoutSeconds === undefined
    ? config.timeoutMs ?? endpoint.timeoutMs ?? 60_000
    : integerOption(timeoutSeconds, 60, "--timeout", 1, 3600) * 1000;
  const retries = integerOption(globalOptions.retries ?? process.env.SORFTIME_RETRIES, 0, "--retries", 0, 5);
  if (retries > 0 && endpoint.unsafeRetry && !globalOptions.retryUnsafe) {
    throw new ValidationError(
      `${endpoint.name} creates or changes server-side state. Retry is disabled unless --retry-unsafe is explicitly supplied.`,
    );
  }
  const defaultOutput: OutputFormat = process.stdout.isTTY ? "table" : "json";
  const format = outputFormat(globalOptions.output ?? process.env.SORFTIME_OUTPUT, config.output ?? defaultOutput);
  const maxPages = integerOption(globalOptions.maxPages, 100, "--max-pages", 1, 1000);
  const delayMs = integerOption(globalOptions.pageDelay, 0, "--page-delay", 0, 60_000);
  if (globalOptions.allPages && format === "raw") throw new ValidationError("--all-pages cannot be combined with --output raw.");

  const core = new SorftimeCoreClient({
    token: tokenResult.token,
    baseUrl,
    timeoutMs,
    retries,
    userAgent: "sorftime-cli/1.1.0",
  });
  const requestBody = (requestBodyValue: JsonObject): Promise<JsonValue> => core.call({
    endpoint: endpoint.name,
    marketplace: domain.id,
    body: requestBodyValue,
    ...(signal ? { signal } : {}),
    ...(globalOptions.verbose !== undefined ? { verbose: globalOptions.verbose } : {}),
    ...(format === "raw" ? { rawResponse: true } : {}),
    ...(retries > 0 ? { retryApiThrottle: true } : {}),
  });
  const result = globalOptions.allPages
    ? await requestAllPages(endpoint, body, requestBody, maxPages, delayMs, signal, globalOptions.verbose)
    : await requestBody(body);
  await writeOutput(result, {
    format,
    ...(globalOptions.dataOnly !== undefined ? { dataOnly: globalOptions.dataOnly } : {}),
    ...(globalOptions.select !== undefined ? { select: globalOptions.select } : {}),
    ...(globalOptions.outputFile !== undefined ? { outputFile: globalOptions.outputFile } : {}),
    ...(globalOptions.compact !== undefined ? { compact: globalOptions.compact } : {}),
  });
}
