import { randomUUID } from "node:crypto";
import { governanceFor, type BillingKind, type EndpointEffect } from "../core/governance.js";
import type { JsonValue } from "../types.js";
import { fingerprintInput, type AuditEvent } from "./audit.js";
import type { McpIdentity } from "./config.js";
import type { McpAppContext } from "./context.js";
import { McpPublicError } from "./results.js";

export interface GovernedToolRequest {
  tool: string;
  actor: McpIdentity;
  transport: "stdio" | "http";
  marketplace?: string;
  endpoints: string[];
  input: Record<string, unknown>;
}

export interface GovernedToolResult {
  schemaVersion: "1.0";
  requestId: string;
  marketplace: string | null;
  resultType: string;
  data: JsonValue;
  source: {
    provider: "sorftime";
    endpoints: string[];
    fetchedAt: string;
    billing: "free";
    requestConsumed: number | null;
  };
  warnings: string[];
  partial: false;
}

export interface FullApiToolResult {
  schemaVersion: "1.1";
  requestId: string;
  marketplace: string | null;
  resultType: string;
  data: JsonValue;
  source: {
    provider: "sorftime";
    endpoints: string[];
    fetchedAt: string;
    billing: BillingKind;
    effect: EndpointEffect;
    documentedCost: string;
    requestConsumed: number | null;
  };
  warnings: string[];
  partial: false;
}

function consumedFromPayload(value: JsonValue): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, JsonValue>;
  const key = Object.keys(object).find((candidate) => candidate.toLowerCase() === "requestconsumed");
  const consumed = key ? object[key] : undefined;
  return typeof consumed === "number" && Number.isFinite(consumed) ? consumed : undefined;
}

function stripAccountMetadata(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stripAccountMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, JsonValue>)
      .filter(([key]) => !["requestleft", "requestconsumed", "requestcount"].includes(key.toLowerCase()))
      .map(([key, item]) => [key, stripAccountMetadata(item)]),
  );
}

function auditBase(requestId: string, request: GovernedToolRequest): Omit<AuditEvent, "timestamp" | "event" | "decision" | "outcome"> {
  return {
    requestId,
    actor: request.actor,
    transport: request.transport,
    tool: request.tool,
    marketplace: request.marketplace ?? null,
    endpoints: request.endpoints,
    inputFingerprint: fingerprintInput(request.input),
    inputKeys: Object.keys(request.input).sort(),
  };
}

export async function executeGovernedTool(
  context: McpAppContext,
  request: GovernedToolRequest,
  resultType: string,
  operation: () => Promise<JsonValue | JsonValue[]>,
): Promise<GovernedToolResult> {
  const requestId = randomUUID();
  const base = auditBase(requestId, request);
  const startedAt = performance.now();

  try {
    if (context.billingCircuit.blockedReason) {
      throw new McpPublicError("BILLING_CIRCUIT_OPEN", context.billingCircuit.blockedReason);
    }
    for (const endpoint of request.endpoints) {
      const governance = governanceFor(endpoint);
      if (governance.billing !== "free" || governance.effect !== "read" || governance.exposure === "full_admin") {
        throw new McpPublicError("POLICY_DENIED", `Endpoint ${endpoint} is not allowed by the free read-only MCP policy.`);
      }
      if (governance.exposure === "admin" && request.actor.role !== "admin") {
        throw new McpPublicError("FORBIDDEN", `Endpoint ${endpoint} requires the admin role.`);
      }
    }

    const rate = context.rateLimiter.take(JSON.stringify([request.actor.tenant, request.actor.subject]));
    if (!rate.allowed) {
      throw new McpPublicError("RATE_LIMITED", "Per-user MCP rate limit reached.", true, {
        retryAfterSeconds: rate.retryAfterSeconds,
      });
    }

    await context.audit.record({
      ...base,
      timestamp: new Date().toISOString(),
      event: "tool_start",
      decision: "allow",
      outcome: "started",
    });

    const raw = await operation();
    const payloads = Array.isArray(raw) ? raw : [raw];
    const consumedValues = payloads.map(consumedFromPayload).filter((value): value is number => value !== undefined);
    const requestConsumed = consumedValues.length > 0 ? consumedValues.reduce((sum, value) => sum + value, 0) : null;
    const warnings: string[] = [];
    if (requestConsumed !== null && requestConsumed > 0) {
      const message = "A supposedly free endpoint reported request consumption; MCP execution is blocked until an administrator investigates.";
      context.billingCircuit.blockedReason = message;
      warnings.push(message);
    }

    await context.audit.record({
      ...base,
      timestamp: new Date().toISOString(),
      event: "tool_finish",
      decision: "allow",
      outcome: "success",
      durationMs: Math.round(performance.now() - startedAt),
      ...(requestConsumed !== null ? { requestConsumed } : {}),
    });
    return {
      schemaVersion: "1.0",
      requestId,
      marketplace: request.marketplace ?? null,
      resultType,
      data: ["sorftime_check_quota", "sorftime_get_account_usage"].includes(request.tool)
        ? raw as JsonValue
        : stripAccountMetadata(raw as JsonValue),
      source: {
        provider: "sorftime",
        endpoints: request.endpoints,
        fetchedAt: new Date().toISOString(),
        billing: "free",
        requestConsumed,
      },
      warnings,
      partial: false,
    };
  } catch (error) {
    const code = error instanceof McpPublicError ? error.code : "UPSTREAM_ERROR";
    const outcome = code === "RATE_LIMITED" ? "rate_limited" : code === "POLICY_DENIED" || code === "FORBIDDEN" || code === "BILLING_CIRCUIT_OPEN" ? "policy_denied" : "error";
    await context.audit.record({
      ...base,
      timestamp: new Date().toISOString(),
      event: "tool_denied",
      decision: outcome === "error" ? "allow" : "deny",
      outcome,
      durationMs: Math.round(performance.now() - startedAt),
      errorCode: code,
    });
    if (error instanceof McpPublicError) {
      throw new McpPublicError(error.code, error.message, error.retryable, error.details, requestId);
    }
    throw new McpPublicError(
      "UPSTREAM_ERROR",
      "Sorftime upstream request failed. Contact the service owner with requestId.",
      true,
      {},
      requestId,
    );
  }
}

/** Executes one fixed endpoint in explicit full-admin mode. Endpoint selection never comes from tool input. */
export async function executeFullApiTool(
  context: McpAppContext,
  request: GovernedToolRequest,
  resultType: string,
  documentedCost: string,
  confirmed: boolean,
  operation: () => Promise<JsonValue>,
): Promise<FullApiToolResult> {
  const requestId = randomUUID();
  const base = auditBase(requestId, request);
  const startedAt = performance.now();

  try {
    if (!context.config.governance.enableFullApiTools || request.actor.role !== "admin") {
      throw new McpPublicError("FORBIDDEN", "Full Sorftime API tools require explicit server enablement and an authenticated admin identity.");
    }
    if (request.endpoints.length !== 1) {
      throw new McpPublicError("POLICY_DENIED", "Full API tools must map to exactly one fixed Sorftime endpoint.");
    }
    if (context.billingCircuit.blockedReason) {
      throw new McpPublicError("BILLING_CIRCUIT_OPEN", context.billingCircuit.blockedReason);
    }
    const endpoint = request.endpoints[0]!;
    const governance = governanceFor(endpoint);
    const confirmationRequired = governance.billing !== "free" || governance.effect !== "read";
    if (confirmationRequired && !confirmed) {
      throw new McpPublicError("CONFIRMATION_REQUIRED", `Endpoint ${endpoint} may consume quota or change account state. Explicit confirmation is required.`);
    }

    const rate = context.rateLimiter.take(JSON.stringify([request.actor.tenant, request.actor.subject]));
    if (!rate.allowed) {
      throw new McpPublicError("RATE_LIMITED", "Per-user MCP rate limit reached.", true, {
        retryAfterSeconds: rate.retryAfterSeconds,
      });
    }

    await context.audit.record({
      ...base,
      timestamp: new Date().toISOString(),
      event: "tool_start",
      decision: "allow",
      outcome: "started",
    });

    const raw = await operation();
    const requestConsumed = consumedFromPayload(raw) ?? null;
    const warnings: string[] = [];
    if (governance.billing === "free" && requestConsumed !== null && requestConsumed > 0) {
      const message = "A documented free endpoint reported request consumption; MCP execution is blocked until an administrator investigates.";
      context.billingCircuit.blockedReason = message;
      warnings.push(message);
    }
    if (governance.billing !== "free") {
      warnings.push(`This endpoint has documented billing '${governance.billing}' with cost guidance: ${documentedCost}.`);
    }
    if (governance.effect !== "read") {
      warnings.push(`This endpoint has '${governance.effect}' effects on shared Sorftime account state.`);
    }

    await context.audit.record({
      ...base,
      timestamp: new Date().toISOString(),
      event: "tool_finish",
      decision: "allow",
      outcome: "success",
      durationMs: Math.round(performance.now() - startedAt),
      ...(requestConsumed !== null ? { requestConsumed } : {}),
    });
    const retainAccountMetadata = ["CoinQuery", "CoinStream", "RequestStreamMonth"].includes(endpoint);
    return {
      schemaVersion: "1.1",
      requestId,
      marketplace: request.marketplace ?? null,
      resultType,
      data: retainAccountMetadata ? raw : stripAccountMetadata(raw),
      source: {
        provider: "sorftime",
        endpoints: [endpoint],
        fetchedAt: new Date().toISOString(),
        billing: governance.billing,
        effect: governance.effect,
        documentedCost,
        requestConsumed,
      },
      warnings,
      partial: false,
    };
  } catch (error) {
    const code = error instanceof McpPublicError ? error.code : "UPSTREAM_ERROR";
    const outcome = code === "RATE_LIMITED" ? "rate_limited"
      : ["POLICY_DENIED", "FORBIDDEN", "BILLING_CIRCUIT_OPEN", "CONFIRMATION_REQUIRED"].includes(code) ? "policy_denied"
        : "error";
    await context.audit.record({
      ...base,
      timestamp: new Date().toISOString(),
      event: "tool_denied",
      decision: outcome === "error" ? "allow" : "deny",
      outcome,
      durationMs: Math.round(performance.now() - startedAt),
      errorCode: code,
    });
    if (error instanceof McpPublicError) {
      throw new McpPublicError(error.code, error.message, error.retryable, error.details, requestId);
    }
    throw new McpPublicError(
      "UPSTREAM_ERROR",
      "Sorftime upstream request failed. Contact the service owner with requestId.",
      true,
      {},
      requestId,
    );
  }
}
