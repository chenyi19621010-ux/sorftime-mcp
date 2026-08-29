import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { DOMAINS } from "../domains.js";
import type { JsonObject, JsonValue } from "../types.js";
import type { McpIdentity } from "./config.js";
import type { McpAppContext } from "./context.js";
import { executeGovernedTool } from "./executor.js";
import { fullApiToolNames, registerFullApiTools } from "./full-tools.js";
import { toolError, toolSuccess } from "./results.js";

const VERSION = "1.1.0";
const MarketplaceSchema = z.enum(["US", "GB", "DE", "FR", "IN", "CA", "JP", "ES", "IT", "MX", "AE", "AU", "BR", "SA"]);
const AsinSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/u, "ASIN must contain exactly 10 uppercase letters/digits");
const IdSchema = z.string().trim().min(1).max(200)
  .refine((value) => !value.includes(",") && !/\s/u.test(value) && [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  }), "Identifier must not contain whitespace, commas, or control characters");
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "Date must be a real calendar date in YYYY-MM-DD format");
const DateHourSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3])$/u).refine((value) => {
  const [datePart, hourPart] = value.split(" ");
  const date = new Date(`${datePart}T${hourPart}:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 13) === `${datePart}T${hourPart}`;
}, "Date and hour must be real in YYYY-MM-DD HH format");

function withinTwelveMonths(startDate: string, endDate: string): boolean {
  const maximum = new Date(`${startDate}T00:00:00Z`);
  maximum.setUTCFullYear(maximum.getUTCFullYear() + 1);
  return new Date(`${endDate}T00:00:00Z`) <= maximum;
}

const ReadOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const GovernedResultSchema = z.object({
  schemaVersion: z.literal("1.0"),
  requestId: z.string().uuid(),
  marketplace: z.string().nullable(),
  resultType: z.string(),
  data: z.json(),
  source: z.object({
    provider: z.literal("sorftime"),
    endpoints: z.array(z.string()),
    fetchedAt: z.string(),
    billing: z.literal("free"),
    requestConsumed: z.number().nullable(),
  }).strict(),
  warnings: z.array(z.string()),
  partial: z.literal(false),
}).strict();

function body(entries: Record<string, unknown>): JsonObject {
  return entries as JsonObject;
}

function summary(resultType: string): string {
  return `${resultType} completed through the free read-only Sorftime MCP policy. Full data is in structuredContent.`;
}

function field(object: JsonValue | undefined, expected: string): JsonValue | undefined {
  if (!object || typeof object !== "object" || Array.isArray(object)) return undefined;
  const record = object as Record<string, JsonValue>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === expected.toLowerCase());
  return key ? record[key] : undefined;
}

function quotaSummary(payload: JsonValue): JsonValue {
  const responses = Array.isArray(payload) ? payload : [];
  const coinResponse = responses[0];
  const requestResponse = responses[1];
  const coin = field(field(coinResponse, "Data"), "Coin");
  const requestLeft = field(requestResponse, "RequestLeft");
  return {
    scope: "global_account",
    coinRemaining: typeof coin === "number" ? coin : null,
    requestRemaining: typeof requestLeft === "number" ? requestLeft : null,
    note: "Balances belong to the shared Sorftime account; detailed package and consumption rows are withheld from reader tools.",
  };
}

export interface McpServerOptions {
  identity: McpIdentity;
  transport: "stdio" | "http";
}

export function createSorftimeMcpServer(context: McpAppContext, options: McpServerOptions): McpServer {
  const fullApiEnabled = context.config.governance.enableFullApiTools && options.identity.role === "admin";
  const server = new McpServer(
    { name: "sorftime-governed-mcp", version: VERSION },
    {
      instructions: fullApiEnabled
        ? "Governed Sorftime full-admin data service. All 52 fixed endpoints are available. Paid or state-changing tools require confirmation. Never repeat charged or mutating calls automatically; preserve source, billing, warnings, and timestamps."
        : "Governed Sorftime team data service. Only explicitly allowlisted free read-only operations are available. Paid product/category/keyword research and all create/update/delete calls are unavailable unless full-admin mode is explicitly enabled. Use the Skill for routing and preserve source timestamps and warnings.",
    },
  );

  server.registerTool(
    "sorftime_capabilities",
    {
      title: "查看 Sorftime MCP 治理能力",
      description: "列出当前免费只读工具、站点、策略边界和被禁用的能力类别；不调用 Sorftime API。",
      inputSchema: z.object({}).strict(),
      outputSchema: GovernedResultSchema,
      annotations: { ...ReadOnlyAnnotations, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await executeGovernedTool(
          context,
          { tool: "sorftime_capabilities", actor: options.identity, transport: options.transport, endpoints: [], input: {} },
          "capabilities",
          async () => ({
            policyVersion: VERSION,
            mode: fullApiEnabled ? "full_admin" : "free_read_only",
            marketplaces: DOMAINS.map(({ id, code, name }) => ({ id, code, name })),
            readerTools: ["sorftime_capabilities", "sorftime_list_monitors", "sorftime_get_monitoring_results", "sorftime_check_quota"],
            adminToolsEnabled: context.config.governance.enableAdminTools && options.identity.role === "admin",
            fullApiToolsEnabled: fullApiEnabled,
            fullApiToolCount: fullApiEnabled ? fullApiToolNames().length : 0,
            fullApiTools: fullApiEnabled ? fullApiToolNames() : [],
            disabledClasses: fullApiEnabled ? ["mcp_arbitrary_endpoint_call"] : ["paid_reads", "coin_charged_calls", "task_creation", "updates", "deletes", "mcp_arbitrary_endpoint_call"],
            rawCallGuidance: "Every MCP tool maps to one fixed registered Sorftime endpoint. Arbitrary endpoint-name passthrough is not exposed.",
          }),
        );
        return toolSuccess(result, summary("capabilities"));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const ListMonitorsSchema = z.object({
    marketplace: MarketplaceSchema,
    monitorType: z.enum(["keyword_ranking", "best_seller", "asin_subscription", "seller_stock"]),
    keyword: z.string().trim().min(1).max(200).optional(),
    taskIds: z.array(IdSchema).min(1).max(20).optional(),
    page: z.number().int().min(1).max(10_000).default(1),
    pageSize: z.number().int().min(20).max(200).default(20),
  }).strict().superRefine((input, refinement) => {
    if ((input.keyword || input.taskIds) && input.monitorType !== "keyword_ranking") {
      refinement.addIssue({ code: "custom", message: "keyword/taskIds filters are only valid for keyword_ranking" });
    }
  });

  server.registerTool(
    "sorftime_list_monitors",
    {
      title: "列出既有 Sorftime 监控",
      description: "列出既有关键词排名、榜单或 ASIN 订阅监控。seller_stock 因源接口 schema 未文档化，仅在启用管理员工具时可用。不会创建或修改任务。",
      inputSchema: ListMonitorsSchema,
      outputSchema: GovernedResultSchema,
      annotations: ReadOnlyAnnotations,
    },
    async (input, extra): Promise<CallToolResult> => {
      const route = input.monitorType === "keyword_ranking"
        ? { endpoint: "KeywordTasks", requestBody: body({
            ...(input.keyword ? { Keyword: input.keyword } : {}),
            ...(input.taskIds ? { TaskId: input.taskIds.join(",") } : {}),
            PageIndex: input.page,
            PageSize: input.pageSize,
          }) }
        : input.monitorType === "best_seller"
          ? { endpoint: "BestSellerListTask", requestBody: body({ PageIndex: input.page, PageSize: input.pageSize }) }
          : input.monitorType === "asin_subscription"
            ? { endpoint: "ASINSubscriptionQuery", requestBody: {} }
            : { endpoint: "ProductSellerTasks", requestBody: {} };
      try {
        const result = await executeGovernedTool(
          context,
          {
            tool: "sorftime_list_monitors", actor: options.identity, transport: options.transport,
            marketplace: input.marketplace, endpoints: [route.endpoint], input,
          },
          `monitor_list:${input.monitorType}`,
          () => context.client.call({ endpoint: route.endpoint, marketplace: input.marketplace, body: route.requestBody, signal: extra.signal }),
        );
        return toolSuccess(result, summary(`monitor_list:${input.monitorType}`));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const MonitoringResultsSchema = z.object({
    marketplace: MarketplaceSchema,
    resultType: z.enum(["keyword_runs", "keyword_run_data", "best_seller_data", "seller_runs", "seller_run_data", "asin_subscription_data"]),
    taskId: IdSchema.optional(),
    date: DateSchema.optional(),
    scheduleIds: z.array(IdSchema).min(1).max(20).optional(),
    nodeId: IdSchema.optional(),
    listType: z.union([z.literal(1), z.literal(3), z.literal(4), z.literal(5)]).optional(),
    at: DateHourSchema.optional(),
    scheduleId: IdSchema.optional(),
    asins: z.array(AsinSchema).min(1).max(100).optional(),
  }).strict().superRefine((input, refinement) => {
    const requireField = (field: keyof typeof input): void => {
      if (input[field] === undefined) refinement.addIssue({ code: "custom", path: [field], message: `${field} is required for ${input.resultType}` });
    };
    if (["keyword_runs", "seller_runs"].includes(input.resultType)) requireField("taskId");
    if (input.resultType === "keyword_run_data") requireField("scheduleIds");
    if (input.resultType === "best_seller_data") {
      requireField("nodeId"); requireField("listType"); requireField("at");
    }
    if (input.resultType === "seller_run_data") requireField("scheduleId");
    if (input.resultType === "asin_subscription_data") requireField("asins");
  });

  server.registerTool(
    "sorftime_get_monitoring_results",
    {
      title: "读取既有 Sorftime 监控结果",
      description: "读取既有关键词批次、榜单、跟卖库存批次或有效 ASIN 订阅结果。调用方必须先持有任务/批次/ASIN 标识；不会创建、更新或删除监控。",
      inputSchema: MonitoringResultsSchema,
      outputSchema: GovernedResultSchema,
      annotations: ReadOnlyAnnotations,
    },
    async (input, extra): Promise<CallToolResult> => {
      const route = input.resultType === "keyword_runs"
        ? { endpoint: "KeywordBatchScheduleList", requestBody: body({ TaskId: input.taskId!, ...(input.date ? { QueryDate: input.date } : {}) }) }
        : input.resultType === "keyword_run_data"
          ? { endpoint: "KeywordBatchScheduleDetail", requestBody: body({ ScheduleId: input.scheduleIds!.join(",") }) }
          : input.resultType === "best_seller_data"
            ? { endpoint: "BestSellerListDataCollect", requestBody: body({ NodeId: input.nodeId!, BestSellerListType: input.listType!, QueryDate: input.at! }) }
            : input.resultType === "seller_runs"
              ? { endpoint: "ProductSellerTaskScheduleList", requestBody: body({ TaskId: input.taskId! }) }
              : input.resultType === "seller_run_data"
                ? { endpoint: "ProductSellerTaskScheduleDetail", requestBody: body({ ScheduleId: input.scheduleId! }) }
                : { endpoint: "ASINSubscriptionCollection", requestBody: body({ Asins: input.asins!.join(",") }) };
      try {
        const result = await executeGovernedTool(
          context,
          {
            tool: "sorftime_get_monitoring_results", actor: options.identity, transport: options.transport,
            marketplace: input.marketplace, endpoints: [route.endpoint], input,
          },
          input.resultType,
          () => context.client.call({ endpoint: route.endpoint, marketplace: input.marketplace, body: route.requestBody, signal: extra.signal }),
        );
        return toolSuccess(result, summary(input.resultType));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "sorftime_check_quota",
    {
      title: "查看 Sorftime 共享账户配额",
      description: "读取共享账户的 Coin 与 Request 总余额/近期状态。结果属于整个共享账户，不代表当前员工的个人额度。",
      inputSchema: z.object({}).strict(),
      outputSchema: GovernedResultSchema,
      annotations: ReadOnlyAnnotations,
    },
    async (_input, extra): Promise<CallToolResult> => {
      try {
        const endpoints = ["CoinQuery", "RequestStreamMonth"];
        const result = await executeGovernedTool(
          context,
          { tool: "sorftime_check_quota", actor: options.identity, transport: options.transport, endpoints, input: {} },
          "global_account_quota",
          async (): Promise<JsonValue[]> => Promise.all(endpoints.map((endpoint) =>
            context.client.call({ endpoint, marketplace: "US", signal: extra.signal }),
          )),
        );
        result.data = quotaSummary(result.data);
        result.warnings.push("Quota is global to the shared Sorftime account, not an employee-level allowance.");
        return toolSuccess(result, "Shared Sorftime account quota retrieved. Treat it as global, not per-user.");
      } catch (error) {
        return toolError(error);
      }
    },
  );

  if (context.config.governance.enableAdminTools && options.identity.role === "admin") {
    server.registerTool(
      "sorftime_get_account_usage",
      {
        title: "查看 Sorftime 账户积分使用明细（管理员）",
        description: "管理员读取指定站点与日期范围内的共享账户 Coin 使用明细；只读但可能暴露团队操作信息。",
        inputSchema: z.object({
          marketplace: MarketplaceSchema,
          startDate: DateSchema,
          endDate: DateSchema,
          page: z.number().int().min(1).max(10_000).default(1),
          pageSize: z.number().int().min(20).max(200).default(20),
        }).strict()
          .refine((input) => input.startDate <= input.endDate, { message: "startDate must not be after endDate" })
          .refine((input) => withinTwelveMonths(input.startDate, input.endDate), { message: "date range must not exceed 12 months" }),
        outputSchema: GovernedResultSchema,
        annotations: ReadOnlyAnnotations,
      },
      async (input, extra): Promise<CallToolResult> => {
        try {
          const endpoint = "CoinStream";
          const result = await executeGovernedTool(
            context,
            { tool: "sorftime_get_account_usage", actor: options.identity, transport: options.transport, marketplace: input.marketplace, endpoints: [endpoint], input },
            "account_coin_usage",
            () => context.client.call({
              endpoint, marketplace: input.marketplace,
              body: body({ QueryDate: [input.startDate, input.endDate], PageIndex: input.page, PageSize: input.pageSize }),
              signal: extra.signal,
            }),
          );
          return toolSuccess(result, summary("account_coin_usage"));
        } catch (error) {
          return toolError(error);
        }
      },
    );

    const ExistingTaskSchema = z.object({
      marketplace: MarketplaceSchema,
      resultType: z.enum(["review_status", "similar_status", "similar_result", "ai_result"]),
      asin: AsinSchema.optional(),
      lookbackHours: z.number().int().min(1).max(240).default(48),
      taskId: IdSchema.optional(),
    }).strict().superRefine((input, refinement) => {
      if (input.resultType === "review_status" && !input.asin) {
        refinement.addIssue({ code: "custom", path: ["asin"], message: "asin is required for review_status" });
      }
      if (["similar_result", "ai_result"].includes(input.resultType) && !input.taskId) {
        refinement.addIssue({ code: "custom", path: ["taskId"], message: `taskId is required for ${input.resultType}` });
      }
    });
    server.registerTool(
      "sorftime_get_existing_task_result",
      {
        title: "读取 Sorftime 既有异步任务（管理员）",
        description: "管理员按已有 ASIN/TaskId 读取评论采集状态、图片搜索状态/结果或 AI 结果。不会创建或轮询新任务。",
        inputSchema: ExistingTaskSchema,
        outputSchema: GovernedResultSchema,
        annotations: ReadOnlyAnnotations,
      },
      async (input, extra): Promise<CallToolResult> => {
        const route = input.resultType === "review_status"
          ? { endpoint: "ProductReviewsCollectionStatusQuery", requestBody: body({ ASIN: input.asin!, Update: input.lookbackHours }) }
          : input.resultType === "similar_status"
            ? { endpoint: "SimilarProductRealtimeRequestStatusQuery", requestBody: body({ Update: input.lookbackHours }) }
            : input.resultType === "similar_result"
              ? { endpoint: "SimilarProductRealtimeRequestCollection", requestBody: body({ TaskId: input.taskId! }) }
              : { endpoint: "AIResult", requestBody: body({ TaskId: input.taskId! }) };
        try {
          const result = await executeGovernedTool(
            context,
            { tool: "sorftime_get_existing_task_result", actor: options.identity, transport: options.transport, marketplace: input.marketplace, endpoints: [route.endpoint], input },
            input.resultType,
            () => context.client.call({ endpoint: route.endpoint, marketplace: input.marketplace, body: route.requestBody, signal: extra.signal }),
          );
          return toolSuccess(result, summary(input.resultType));
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  registerFullApiTools(server, context, options);

  return server;
}
