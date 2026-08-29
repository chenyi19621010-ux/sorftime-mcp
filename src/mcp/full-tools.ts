import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { governanceFor } from "../core/governance.js";
import { ENDPOINTS } from "../endpoints.js";
import { buildRequestBody } from "../input.js";
import type { EndpointSpec, JsonObject, JsonValue, ParameterSpec } from "../types.js";
import type { McpServerOptions } from "./server.js";
import type { McpAppContext } from "./context.js";
import { executeFullApiTool } from "./executor.js";
import { McpPublicError, toolError, toolSuccess } from "./results.js";

const MarketplaceSchema = z.enum(["US", "GB", "DE", "FR", "IN", "CA", "JP", "ES", "IT", "MX", "AE", "AU", "BR", "SA"]);
const MAX_TEXT_LENGTH = 20_000;
const MAX_IMAGE_DATA_URL_LENGTH = 14 * 1024 * 1024;
const MAX_ADVANCED_PAYLOAD_LENGTH = 100_000;

const FullApiResultSchema = z.object({
  schemaVersion: z.literal("1.1"),
  requestId: z.string().uuid(),
  marketplace: z.string().nullable(),
  resultType: z.string(),
  data: z.json(),
  source: z.object({
    provider: z.literal("sorftime"),
    endpoints: z.array(z.string()).length(1),
    fetchedAt: z.string(),
    billing: z.enum(["free", "request", "coin", "recurring_coin", "unknown"]),
    effect: z.enum(["read", "create", "update", "delete"]),
    documentedCost: z.string(),
    requestConsumed: z.number().nullable(),
  }).strict(),
  warnings: z.array(z.string()),
  partial: z.literal(false),
}).strict();

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function stringSchema(parameter: ParameterSpec) {
  let schema = z.string().trim().min(1).max(MAX_TEXT_LENGTH);
  if (parameter.format === "date") schema = schema.refine(validDate, "Must be a real date in YYYY-MM-DD format");
  if (parameter.format === "month") schema = schema.regex(/^\d{4}-(0[1-9]|1[0-2])$/u, "Must use YYYY-MM format");
  if (parameter.format === "date-hour") {
    schema = schema.refine((value) => {
      const match = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3])$/u.exec(value);
      return Boolean(match?.[1] && validDate(match[1]));
    }, "Must use a real date and hour in YYYY-MM-DD HH format");
  }
  return schema;
}

function parameterSchema(parameter: ParameterSpec): z.ZodType {
  let schema: z.ZodType;
  if (parameter.type === "integer" || parameter.type === "number") {
    let numberSchema = parameter.type === "integer" ? z.number().int() : z.number();
    if (parameter.min !== undefined) numberSchema = numberSchema.min(parameter.min);
    if (parameter.max !== undefined) numberSchema = numberSchema.max(parameter.max);
    schema = numberSchema;
  } else if (parameter.type === "boolean") {
    schema = z.boolean();
  } else if (parameter.type === "string[]") {
    schema = z.array(stringSchema(parameter)).min(parameter.required ? 1 : 0).max(100);
  } else if (parameter.type === "json") {
    schema = z.json();
  } else if (parameter.type === "image") {
    schema = z.string().min(1).max(MAX_IMAGE_DATA_URL_LENGTH)
      .regex(/^data:image\/(jpeg|png|webp|gif);base64,/u, "Remote MCP image input must be a JPEG, PNG, WebP, or GIF data URL");
  } else {
    schema = stringSchema(parameter);
  }
  if (parameter.choices) {
    schema = schema.refine(
      (value) => parameter.choices!.some((choice) => choice === value),
      `Must be one of: ${parameter.choices.join(", ")}`,
    );
  }
  schema = schema.describe(`${parameter.description}${parameter.required ? " (required)" : ""}`);
  return parameter.required ? schema : schema.optional();
}

function toolName(endpoint: EndpointSpec): string {
  return `sorftime_${endpoint.group}_${endpoint.command.replaceAll("-", "_")}`;
}

export function fullApiToolNames(): string[] {
  return ENDPOINTS.map(toolName);
}

function allowsAdvancedPayload(endpoint: EndpointSpec): boolean {
  return endpoint.undocumentedParameters === true || endpoint.name === "ProductQuery";
}

function inputSchema(endpoint: EndpointSpec) {
  const governance = governanceFor(endpoint.name);
  const shape: Record<string, z.ZodType> = {
    marketplace: MarketplaceSchema.default("US").describe("Amazon marketplace"),
  };
  for (const parameter of endpoint.parameters) shape[parameter.key] = parameterSchema(parameter);
  if (allowsAdvancedPayload(endpoint)) {
    shape.payload = z.record(z.string().min(1).max(200), z.json())
      .refine((value) => Object.keys(value).length <= 100, "Advanced payload may contain at most 100 fields")
      .refine((value) => JSON.stringify(value).length <= MAX_ADVANCED_PAYLOAD_LENGTH, "Advanced payload is too large")
      .optional()
      .describe("Advanced fixed-endpoint request fields for an incompletely documented Sorftime schema");
  }
  if (governance.billing !== "free" || governance.effect !== "read") {
    shape.confirm = z.literal(true).describe(`Required confirmation: documented cost '${endpoint.cost}', effect '${governance.effect}'`);
  }
  return z.object(shape).strict();
}

function annotations(endpoint: EndpointSpec) {
  const governance = governanceFor(endpoint.name);
  const billed = governance.billing !== "free";
  const potentiallyDestructive = governance.effect === "delete"
    || ["ChangeFavoriteKeyword", "KeywordBatchTaskUpdate", "ProductSellerTaskUpdate", "ASINSubscription"].includes(endpoint.name);
  return {
    readOnlyHint: governance.effect === "read" && !billed,
    destructiveHint: potentiallyDestructive,
    idempotentHint: governance.effect === "read" && !billed,
    openWorldHint: true,
  } as const;
}

function description(endpoint: EndpointSpec): string {
  const governance = governanceFor(endpoint.name);
  const confirmation = governance.billing !== "free" || governance.effect !== "read"
    ? " Explicit confirmation is required before execution."
    : "";
  return `${endpoint.summary}. Fixed Sorftime endpoint: ${endpoint.name}. Documented cost: ${endpoint.cost}. Effect: ${governance.effect}.${confirmation}`;
}

export function registerFullApiTools(server: McpServer, context: McpAppContext, options: McpServerOptions): void {
  if (!context.config.governance.enableFullApiTools || options.identity.role !== "admin") return;

  for (const endpoint of ENDPOINTS) {
    const name = toolName(endpoint);
    server.registerTool(
      name,
      {
        title: `Sorftime · ${endpoint.summary}`,
        description: description(endpoint),
        inputSchema: inputSchema(endpoint),
        outputSchema: FullApiResultSchema,
        annotations: annotations(endpoint),
      },
      async (input, extra): Promise<CallToolResult> => {
        const values = input as Record<string, unknown>;
        const marketplace = String(values.marketplace ?? "US");
        const confirmed = values.confirm === true;
        const advancedPayload = values.payload && typeof values.payload === "object" && !Array.isArray(values.payload)
          ? values.payload as Record<string, JsonValue>
          : {};
        const parameterValues = Object.fromEntries(
          endpoint.parameters
            .filter((parameter) => values[parameter.key] !== undefined)
            .map((parameter) => [parameter.key, values[parameter.key] as JsonValue]),
        );
        const requestBodyInput = { ...advancedPayload, ...parameterValues } as JsonObject;
        try {
          const requestBody = await buildRequestBody(endpoint, { data: JSON.stringify(requestBodyInput) });
          const result = await executeFullApiTool(
            context,
            {
              tool: name,
              actor: options.identity,
              transport: options.transport,
              marketplace,
              endpoints: [endpoint.name],
              input: values,
            },
            `endpoint:${endpoint.name}`,
            endpoint.cost,
            confirmed,
            () => context.client.call({
              endpoint: endpoint.name,
              marketplace,
              body: requestBody,
              signal: extra.signal,
            }),
          );
          return toolSuccess(result, `${endpoint.name} completed. Review structuredContent source, warnings, and billing metadata.`);
        } catch (error) {
          if (error instanceof McpPublicError) return toolError(error);
          return toolError(error);
        }
      },
    );
  }
}
