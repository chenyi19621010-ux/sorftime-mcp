import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { DEFAULT_BASE_URL } from "../client.js";
import { ValidationError } from "../errors.js";

export type McpRole = "reader" | "admin";
export type McpAuthMode = "disabled" | "api_key" | "trusted_headers";

export interface McpIdentity {
  subject: string;
  tenant: string;
  role: McpRole;
  authSource: "disabled" | "api_key" | "trusted_headers" | "stdio_config";
}

export interface ApiKeyIdentity extends McpIdentity {
  key: string;
  authSource: "api_key";
}

const booleanFromEnvironment = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const optionalString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SORFTIME_ACCOUNT_SK: optionalString,
  SORFTIME_ACCOUNT_SK_FILE: optionalString,
  SORFTIME_BASE_URL: z.string().url().default(DEFAULT_BASE_URL),
  SORFTIME_MCP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  SORFTIME_MCP_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_024).max(25_000_000).default(5_000_000),

  MCP_HTTP_HOST: z.string().trim().min(1).default("127.0.0.1"),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  MCP_AUTH_MODE: z.enum(["disabled", "api_key", "trusted_headers"]).default("disabled"),
  MCP_API_KEYS_JSON: z.string().default("[]"),
  MCP_TRUSTED_PROXY_SECRET: optionalString,
  MCP_ALLOWED_ORIGINS: z.string().default(""),
  MCP_ALLOWED_HOSTS: z.string().default(""),
  MCP_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).max(1_000).default(20),
  MCP_MAX_SESSIONS: z.coerce.number().int().min(1).max(10_000).default(100),
  MCP_SESSION_TTL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(1_800_000),
  MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(30),
  MCP_GLOBAL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(300),
  MCP_AUDIT_LOG_PATH: z.string().trim().min(1).default("var/audit.jsonl"),
  MCP_ENABLE_ADMIN_TOOLS: booleanFromEnvironment.default(false),
  MCP_ENABLE_FULL_API_TOOLS: booleanFromEnvironment.default(false),
  MCP_STDIO_SUBJECT: z.string().trim().min(1).max(200).default("local-operator"),
  MCP_STDIO_TENANT: z.string().trim().min(1).max(200).default("local"),
  MCP_STDIO_ROLE: z.enum(["reader", "admin"]).default("reader"),
});

const ApiKeyRecordsSchema = z.array(z.object({
  key: z.string().min(32).max(4_096),
  subject: z.string().trim().min(1).max(200),
  tenant: z.string().trim().min(1).max(200).default("default"),
  role: z.enum(["reader", "admin"]).default("reader"),
}).strict()).max(10_000);

function commaSeparated(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

async function readSecretFile(path: string): Promise<string> {
  const value = await readFile(resolve(path), "utf8");
  if (value.length > 64 * 1024) throw new ValidationError("Sorftime secret file exceeds the 64KB safety limit.");
  return value.trim();
}

export type McpRuntimeConfig = Awaited<ReturnType<typeof loadMcpRuntimeConfig>>;

export async function loadMcpRuntimeConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ValidationError(`Invalid MCP configuration: ${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  let token = env.SORFTIME_ACCOUNT_SK;
  if (env.SORFTIME_ACCOUNT_SK_FILE) {
    if (token) throw new ValidationError("Set only one of SORFTIME_ACCOUNT_SK or SORFTIME_ACCOUNT_SK_FILE.");
    token = await readSecretFile(env.SORFTIME_ACCOUNT_SK_FILE);
  }
  if (!token) throw new ValidationError("MCP server requires SORFTIME_ACCOUNT_SK or SORFTIME_ACCOUNT_SK_FILE.");

  let apiKeyRecords: z.infer<typeof ApiKeyRecordsSchema>;
  try {
    apiKeyRecords = ApiKeyRecordsSchema.parse(JSON.parse(env.MCP_API_KEYS_JSON));
  } catch (error) {
    throw new ValidationError(`MCP_API_KEYS_JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (new Set(apiKeyRecords.map((record) => record.key)).size !== apiKeyRecords.length) {
    throw new ValidationError("MCP_API_KEYS_JSON contains duplicate keys.");
  }
  if (env.MCP_AUTH_MODE === "api_key" && apiKeyRecords.length === 0) {
    throw new ValidationError("MCP_AUTH_MODE=api_key requires at least one MCP_API_KEYS_JSON record.");
  }
  if (env.MCP_AUTH_MODE === "trusted_headers" && (!env.MCP_TRUSTED_PROXY_SECRET || env.MCP_TRUSTED_PROXY_SECRET.length < 32)) {
    throw new ValidationError("MCP_AUTH_MODE=trusted_headers requires MCP_TRUSTED_PROXY_SECRET with at least 32 characters.");
  }

  const allowedHosts = commaSeparated(env.MCP_ALLOWED_HOSTS);
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]).has(env.MCP_HTTP_HOST);
  if ((!loopback || env.NODE_ENV === "production") && env.MCP_AUTH_MODE === "disabled") {
    throw new ValidationError("Production or non-loopback MCP HTTP service cannot disable authentication.");
  }
  if (!loopback && allowedHosts.length === 0) {
    throw new ValidationError("Non-loopback MCP HTTP service requires MCP_ALLOWED_HOSTS for DNS-rebinding protection.");
  }
  const upstreamUrl = new URL(env.SORFTIME_BASE_URL);
  const upstreamLocal = ["localhost", "127.0.0.1", "::1"].includes(upstreamUrl.hostname);
  if (upstreamUrl.protocol !== "https:" && !(env.NODE_ENV !== "production" && upstreamLocal)) {
    throw new ValidationError("SORFTIME_BASE_URL must use HTTPS (HTTP localhost is test/development only). ");
  }
  if (env.NODE_ENV === "production" && isIP(upstreamUrl.hostname) !== 0) {
    throw new ValidationError("Production SORFTIME_BASE_URL must use a certificate-verifiable DNS hostname.");
  }

  return {
    environment: env.NODE_ENV,
    sorftime: {
      token,
      baseUrl: env.SORFTIME_BASE_URL.endsWith("/") ? env.SORFTIME_BASE_URL : `${env.SORFTIME_BASE_URL}/`,
      timeoutMs: env.SORFTIME_MCP_TIMEOUT_MS,
      maxResponseBytes: env.SORFTIME_MCP_MAX_RESPONSE_BYTES,
    },
    http: {
      host: env.MCP_HTTP_HOST,
      port: env.MCP_HTTP_PORT,
      authMode: env.MCP_AUTH_MODE as McpAuthMode,
      apiKeyIdentities: apiKeyRecords.map((record): ApiKeyIdentity => ({ ...record, authSource: "api_key" })),
      trustedProxySecret: env.MCP_TRUSTED_PROXY_SECRET,
      allowedOrigins: commaSeparated(env.MCP_ALLOWED_ORIGINS),
      allowedHosts,
      maxConcurrentRequests: env.MCP_MAX_CONCURRENT_REQUESTS,
      maxSessions: env.MCP_MAX_SESSIONS,
      sessionTtlMs: env.MCP_SESSION_TTL_MS,
    },
    governance: {
      rateLimitPerMinute: env.MCP_RATE_LIMIT_PER_MINUTE,
      globalRateLimitPerMinute: env.MCP_GLOBAL_RATE_LIMIT_PER_MINUTE,
      auditLogPath: resolve(env.MCP_AUDIT_LOG_PATH),
      enableAdminTools: env.MCP_ENABLE_ADMIN_TOOLS,
      enableFullApiTools: env.MCP_ENABLE_FULL_API_TOOLS,
    },
    stdioIdentity: {
      subject: env.MCP_STDIO_SUBJECT,
      tenant: env.MCP_STDIO_TENANT,
      role: env.MCP_STDIO_ROLE,
      authSource: "stdio_config" as const,
    },
  } as const;
}
