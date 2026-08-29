export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ParameterType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "string[]"
  | "json"
  | "image";

export interface ParameterSpec {
  key: string;
  type: ParameterType;
  description: string;
  required?: boolean;
  variadic?: boolean;
  choices?: readonly (string | number)[];
  min?: number;
  max?: number;
  format?: "date" | "month" | "date-hour";
}

export interface EndpointSpec {
  name: string;
  group: "category" | "product" | "keyword" | "monitor" | "agent" | "account";
  command: string;
  aliases?: readonly string[];
  summary: string;
  cost: string;
  parameters: readonly ParameterSpec[];
  timeoutMs?: number;
  undocumentedParameters?: boolean;
  unsafeRetry?: boolean;
  pagination?: {
    pageKey: "Page" | "PageIndex";
    pageSizeKey?: "PageSize";
    defaultPageSize: number;
  };
}

export interface StoredConfig {
  domain?: string | number;
  baseUrl?: string;
  timeoutMs?: number;
  output?: OutputFormat;
}

export type OutputFormat = "json" | "jsonl" | "yaml" | "csv" | "table" | "raw";

export interface ApiRequestOptions {
  endpoint: string;
  domain: number;
  body: JsonObject;
  token: string;
  baseUrl: string;
  timeoutMs: number;
  retries: number;
  signal?: AbortSignal;
  verbose?: boolean;
  rawResponse?: boolean;
  retryApiThrottle?: boolean;
  userAgent?: string;
  maxResponseBytes?: number;
}

export interface GlobalOptions {
  domain?: string;
  token?: string;
  baseUrl?: string;
  timeout?: string;
  retries?: string;
  output?: OutputFormat;
  select?: string;
  dataOnly?: boolean;
  outputFile?: string;
  compact?: boolean;
  verbose?: boolean;
  force?: boolean;
  retryUnsafe?: boolean;
  allPages?: boolean;
  maxPages?: string;
  pageDelay?: string;
}
