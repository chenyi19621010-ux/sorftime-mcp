import { SorftimeCoreClient } from "../core/service.js";
import { validateGovernanceCatalog } from "../core/governance.js";
import { FileAuditSink, type AuditSink } from "./audit.js";
import { loadMcpRuntimeConfig, type McpRuntimeConfig } from "./config.js";
import { IdentityRateLimiter } from "./rate-limit.js";

export interface BillingCircuit {
  blockedReason?: string;
}

export interface McpAppContext {
  config: McpRuntimeConfig;
  client: SorftimeCoreClient;
  audit: AuditSink;
  rateLimiter: IdentityRateLimiter;
  billingCircuit: BillingCircuit;
}

export async function createMcpAppContext(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Pick<McpAppContext, "audit" | "rateLimiter">> = {},
): Promise<McpAppContext> {
  validateGovernanceCatalog();
  const config = await loadMcpRuntimeConfig(environment);
  return {
    config,
    client: new SorftimeCoreClient({
      token: config.sorftime.token,
      baseUrl: config.sorftime.baseUrl,
      timeoutMs: config.sorftime.timeoutMs,
      retries: 0,
      userAgent: "sorftime-mcp/1.1.0",
      maxResponseBytes: config.sorftime.maxResponseBytes,
    }),
    audit: overrides.audit ?? new FileAuditSink(config.governance.auditLogPath),
    rateLimiter: overrides.rateLimiter ?? new IdentityRateLimiter(
      config.governance.rateLimitPerMinute,
      config.governance.globalRateLimitPerMinute,
    ),
    billingCircuit: {},
  };
}
