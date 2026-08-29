import type { EndpointSpec, ParameterSpec } from "./types.js";

const p = (
  key: string,
  type: ParameterSpec["type"],
  description: string,
  options: Omit<ParameterSpec, "key" | "type" | "description"> = {},
): ParameterSpec => ({ key, type, description, ...options });

const asin = (key = "ASIN", type: ParameterSpec["type"] = "string"): ParameterSpec =>
  p(key, type, "Amazon ASIN", { required: true, variadic: type === "string[]" });
const nodeId = (): ParameterSpec => p("NodeId", "string", "Amazon category node ID", { required: true });
const page = (): ParameterSpec => p("Page", "integer", "Page number (starts at 1)", { min: 1 });
const pageIndex = (): ParameterSpec => p("PageIndex", "integer", "Page number (starts at 1)", { min: 1 });
const pageSize = (): ParameterSpec => p("PageSize", "integer", "Rows per page (20-200)", { min: 20, max: 200 });
const taskId = (): ParameterSpec => p("TaskId", "string", "Task ID", { required: true });
const scheduleId = (): ParameterSpec => p("ScheduleId", "string", "Execution batch/schedule ID", { required: true });
const queryDate = (required = false): ParameterSpec =>
  p("QueryDate", "string", "Query date (YYYY-MM-DD)", { required, format: "date" });

export const ENDPOINTS: readonly EndpointSpec[] = [
  {
    name: "CategoryTree", group: "category", command: "tree",
    summary: "Fetch the full Amazon Best Sellers category tree", cost: "5 requests",
    parameters: [], timeoutMs: 300_000,
  },
  {
    name: "CategoryRequest", group: "category", command: "best-sellers",
    summary: "Fetch category Top 100 Best Sellers, optionally with history", cost: "5 realtime; 10 per historical 3-day block",
    parameters: [
      nodeId(),
      p("QueryStart", "string", "Historical range start (YYYY-MM-DD)", { format: "date" }),
      queryDate(),
      p("QueryDays", "integer", "Legacy number of days before QueryDate", { min: 1 }),
    ],
  },
  {
    name: "CategoryProducts", group: "category", command: "products",
    summary: "Fetch hot products in a category", cost: "5 requests",
    parameters: [nodeId(), page(), p("Range", "integer", "Keep the top N products by monthly sales", { min: 1 })],
    pagination: { pageKey: "Page", defaultPageSize: 100 },
  },
  {
    name: "CategoryTrend", group: "category", command: "trend",
    summary: "Fetch up to two years of category trend data", cost: "5 requests",
    parameters: [
      nodeId(),
      p("TrendIndex", "integer", "Trend metric index (0-15)", { required: true, min: 0, max: 15 }),
    ],
  },

  {
    name: "ProductRequest", group: "product", command: "get",
    summary: "Fetch product details and optional trend data", cost: "1 per ASIN; 2 for trends longer than 15 days",
    parameters: [
      asin("ASIN", "string[]"),
      p("Trend", "integer", "1 includes trend data; 2 excludes it", { choices: [1, 2] }),
      p("QueryTrendStartDt", "string", "Trend range start (YYYY-MM-DD)", { format: "date" }),
      p("QueryTrendEndDt", "string", "Trend range end (YYYY-MM-DD)", { format: "date" }),
    ],
  },
  {
    name: "ProductQuery", group: "product", command: "search",
    summary: "Search products by one or multiple conditions", cost: "5 requests",
    parameters: [
      page(),
      p("Query", "integer", "1 single condition; 2 multi-condition AND", { choices: [1, 2] }),
      p("QueryType", "string", "Single-condition query type (1-16)"),
      p("Pattern", "string", "Search value for QueryType"),
    ],
  },
  {
    name: "AsinSalesVolume", group: "product", command: "sales-volume",
    summary: "Fetch officially published child-ASIN sales history", cost: "1 request",
    parameters: [
      asin(), page(), queryDate(),
      p("QueryEndDate", "string", "Range end (YYYY-MM-DD)", { format: "date" }),
    ],
    pagination: { pageKey: "Page", defaultPageSize: 100 },
  },
  {
    name: "ProductVariationHistory", group: "product", command: "variation-history",
    summary: "Fetch recent variation changes for a listing", cost: "1 request", parameters: [asin()],
  },
  {
    name: "ProductRealtimeRequest", group: "product", command: "realtime-start",
    summary: "Start a realtime product crawl", cost: "1 request; JP 2",
    parameters: [asin(), p("Update", "integer", "Reuse data newer than this many hours (1-120)", { min: 1, max: 120 })],
    unsafeRetry: true,
  },
  {
    name: "ProductRealtimeRequestStatusQuery", group: "product", command: "realtime-status",
    summary: "List realtime product crawl tasks created on a date", cost: "1 request", parameters: [queryDate(true)],
  },
  {
    name: "ProductReviewsCollection", group: "product", command: "reviews-collect",
    summary: "Start an asynchronous review collection task", cost: "2 coin points per 10 reviews; minimum 2",
    parameters: [
      asin(),
      p("Mode", "integer", "0 top reviews; 1 most recent", { required: true, choices: [0, 1] }),
      p("Star", "string", "Comma-separated star filters: 1-5, 10 negative, 11 positive"),
      p("OnlyPurchase", "integer", "1 collects verified-purchase reviews only", { choices: [0, 1] }),
      page(),
    ],
    unsafeRetry: true,
  },
  {
    name: "ProductReviewsCollectionStatusQuery", group: "product", command: "reviews-status",
    summary: "Query review collection status", cost: "free",
    parameters: [asin(), p("Update", "integer", "Look back this many hours (1-240)", { min: 1, max: 240 })],
  },
  {
    name: "ProductReviewsQuery", group: "product", command: "reviews-list",
    summary: "Fetch collected product reviews", cost: "5 requests",
    parameters: [
      asin(),
      p("Querystartdt", "string", "Review range start (YYYY-MM-DD)", { format: "date" }),
      pageIndex(),
      p("Star", "string", "Comma-separated star filters: 1-5, 10 negative, 11 positive"),
      p("OnlyPurchase", "integer", "0 all; 1 verified-purchase only", { choices: [0, 1] }),
    ],
    pagination: { pageKey: "PageIndex", defaultPageSize: 100 },
  },
  {
    name: "SimilarProductRealtimeRequest", group: "product", command: "similar-start",
    summary: "Start an image-based similar-product search", cost: "5 requests; JP 6",
    parameters: [p("Image", "image", "Image data URL, or @/path/to/image", { required: true })], timeoutMs: 120_000,
    unsafeRetry: true,
  },
  {
    name: "SimilarProductRealtimeRequestStatusQuery", group: "product", command: "similar-status",
    summary: "Query image-search task status", cost: "free",
    parameters: [p("Update", "integer", "Look back this many hours (1-240)", { min: 1, max: 240 })],
  },
  {
    name: "SimilarProductRealtimeRequestCollection", group: "product", command: "similar-results",
    summary: "Fetch image-search results", cost: "free", parameters: [taskId()],
  },

  {
    name: "KeywordQuery", group: "keyword", command: "list",
    summary: "List current Amazon Brand Analytics keywords", cost: "5 requests",
    parameters: [p("Pattern", "json", "KeywordQueryPattern JSON object"), pageIndex(), pageSize()],
    pagination: { pageKey: "PageIndex", pageSizeKey: "PageSize", defaultPageSize: 20 },
  },
  {
    name: "KeywordSearchResults", group: "keyword", command: "search-results",
    summary: "Fetch recent search-result products for an ABA keyword", cost: "5 requests",
    parameters: [p("Keyword", "string", "ABA keyword", { required: true }), pageIndex(), pageSize()],
    pagination: { pageKey: "PageIndex", pageSizeKey: "PageSize", defaultPageSize: 20 },
  },
  {
    name: "KeywordRequest", group: "keyword", command: "get",
    summary: "Fetch keyword details, search volume and CPC trend", cost: "1 request",
    parameters: [p("Keyword", "string", "ABA keyword", { required: true })],
  },
  {
    name: "KeywordSearchResultTrend", group: "keyword", command: "search-trend",
    summary: "Fetch product-statistics trend for the first three result pages", cost: "10 requests",
    parameters: [
      p("Keyword", "string", "ABA keyword", { required: true }),
      p("QueryStart", "string", "Start month (YYYY-MM)", { format: "month" }),
      p("QueryEnd", "string", "End month (YYYY-MM)", { format: "month" }),
    ],
  },
  {
    name: "CategoryRequestKeyword", group: "keyword", command: "by-category",
    summary: "Find ABA keywords associated with a leaf category", cost: "1 request",
    parameters: [nodeId(), pageIndex(), pageSize()],
    pagination: { pageKey: "PageIndex", pageSizeKey: "PageSize", defaultPageSize: 20 },
  },
  {
    name: "ASINRequestKeyword", group: "keyword", command: "by-asin",
    summary: "Find keywords where an ASIN ranked in the first three pages", cost: "1 request",
    parameters: [asin(), pageIndex(), pageSize()],
    pagination: { pageKey: "PageIndex", pageSizeKey: "PageSize", defaultPageSize: 20 },
  },
  {
    name: "KeywordProductRanking", group: "keyword", command: "product-ranking",
    summary: "Fetch historical monthly keyword result products", cost: "5 requests",
    parameters: [
      p("Keyword", "string", "ABA keyword", { required: true }),
      p("Month", "string", "Historical month (YYYY-MM; US only)", { format: "month" }), page(),
    ],
    pagination: { pageKey: "Page", defaultPageSize: 200 },
  },
  {
    name: "ASINKeywordRanking", group: "keyword", command: "asin-ranking",
    summary: "Fetch an ASIN's rank trend for a keyword", cost: "2 requests",
    parameters: [
      p("Keyword", "string", "ABA keyword", { required: true }), asin(),
      p("QueryStart", "string", "Range start (YYYY-MM-DD)", { format: "date" }),
      p("QueryEnd", "string", "Range end (YYYY-MM-DD)", { format: "date" }), page(),
    ],
    pagination: { pageKey: "Page", defaultPageSize: 200 },
  },
  {
    name: "KeywordExtends", group: "keyword", command: "extend",
    summary: "Fetch related ABA keywords", cost: "5 requests",
    parameters: [p("Keyword", "string", "ABA keyword", { required: true }), pageIndex(), pageSize()],
    pagination: { pageKey: "PageIndex", pageSizeKey: "PageSize", defaultPageSize: 20 },
  },
  {
    name: "FavoriteKeyword", group: "keyword", command: "favorite-add",
    summary: "Add a keyword to the API personal dictionary", cost: "1 request",
    parameters: [
      p("Keyword", "string", "Keyword to save", { required: true }),
      p("Dict", "string", "Dictionary/folder name (created if absent)"),
    ],
    unsafeRetry: true,
  },
  {
    name: "ChangeFavoriteKeyword", group: "keyword", command: "favorite-change",
    summary: "Move or delete a personal-dictionary keyword", cost: "1 request",
    parameters: [], undocumentedParameters: true, unsafeRetry: true,
  },
  {
    name: "GetFavoriteKeyword", group: "keyword", command: "favorite-list",
    summary: "List personal-dictionary keywords", cost: "unknown",
    parameters: [], undocumentedParameters: true,
  },

  {
    name: "KeywordBatchSubscription", group: "monitor", command: "keyword-create",
    summary: "Create keyword-ranking monitor tasks", cost: "free API call; monitoring uses coin points",
    parameters: [
      p("Keyword", "string[]", "Keyword to monitor (repeatable)", { required: true, variadic: true }),
      p("Mode", "integer", "0 desktop; 1 mobile", { required: true, choices: [0, 1] }),
      p("Area", "string", "Postal code/area (required for desktop mode)"), page(),
      p("Period", "string", "Monitoring period expression, e.g. 1|1|1"),
    ],
    unsafeRetry: true,
  },
  {
    name: "KeywordTasks", group: "monitor", command: "keyword-list",
    summary: "List active keyword monitor tasks", cost: "free",
    parameters: [
      p("Keyword", "string", "Fuzzy keyword filter"), p("TaskId", "string", "Comma-separated task IDs"), pageIndex(), pageSize(),
    ],
    pagination: { pageKey: "PageIndex", pageSizeKey: "PageSize", defaultPageSize: 20 },
  },
  {
    name: "KeywordBatchTaskUpdate", group: "monitor", command: "keyword-update",
    summary: "Modify, pause, start or delete a keyword monitor task", cost: "free",
    parameters: [
      p("TaskId", "integer", "Keyword monitor task ID", { required: true }),
      p("Update", "integer", "0 modify; 1 pause; 2 start; 9 delete", { required: true, choices: [0, 1, 2, 9] }),
      p("Mode", "integer", "0 desktop; 1 mobile", { choices: [0, 1] }),
      p("Area", "string", "Postal code/area"), page(), p("Period", "string", "Monitoring period expression"),
    ],
    unsafeRetry: true,
  },
  {
    name: "KeywordBatchScheduleList", group: "monitor", command: "keyword-runs",
    summary: "List keyword monitor execution batches", cost: "free",
    parameters: [p("TaskId", "string", "Keyword monitor task ID", { required: true }), queryDate()],
  },
  {
    name: "KeywordBatchScheduleDetail", group: "monitor", command: "keyword-run-data",
    summary: "Fetch keyword monitor execution details", cost: "free", parameters: [scheduleId()],
  },
  {
    name: "BestSellerListSubscription", group: "monitor", command: "best-seller-create",
    summary: "Create or modify a Best Seller list monitor", cost: "free API call; 10-40 points/day",
    parameters: [
      nodeId(), p("Range", "integer", "Monitoring depth; 1 means Top 100", { min: 1 }),
      p("Period", "integer", "100/106/112/118 daily or 200/201 every two hours", { required: true, choices: [100, 106, 112, 118, 200, 201] }),
      p("BestSellerListType", "integer", "1 New Releases; 3 Most Wished; 4 Gift Ideas; 5 Best Sellers", { required: true, choices: [1, 3, 4, 5] }),
    ],
    unsafeRetry: true,
  },
  {
    name: "BestSellerListTask", group: "monitor", command: "best-seller-list",
    summary: "List Best Seller monitor tasks", cost: "free", parameters: [pageIndex(), pageSize()],
    pagination: { pageKey: "PageIndex", pageSizeKey: "PageSize", defaultPageSize: 20 },
  },
  {
    name: "BestSellerListDelete", group: "monitor", command: "best-seller-delete",
    summary: "Delete a Best Seller monitor", cost: "free",
    parameters: [
      nodeId(),
      p("BestSellerListType", "integer", "1 New Releases; 3 Most Wished; 4 Gift Ideas; 5 Best Sellers", { required: true, choices: [1, 3, 4, 5] }),
    ],
    unsafeRetry: true,
  },
  {
    name: "BestSellerListDataCollect", group: "monitor", command: "best-seller-data",
    summary: "Fetch monitored Best Seller list data", cost: "free",
    parameters: [
      nodeId(),
      p("BestSellerListType", "integer", "1 New Releases; 3 Most Wished; 4 Gift Ideas; 5 Best Sellers", { required: true, choices: [1, 3, 4, 5] }),
      p("QueryDate", "string", "Data time (YYYY-MM-DD HH)", { required: true, format: "date-hour" }),
    ],
  },
  {
    name: "ProductSellerSubscription", group: "monitor", command: "seller-create",
    summary: "Create a seller and stock monitor", cost: "2 points/ASIN/period; JP 4; stock extra",
    parameters: [
      asin("Asin"), p("CheckStock", "integer", "0 do not check stock; 1 check stock", { choices: [0, 1] }),
      p("Period", "string", "Monitoring period expression, e.g. 1|1|1", { required: true }),
    ],
    unsafeRetry: true,
  },
  {
    name: "ProductSellerTasks", group: "monitor", command: "seller-list",
    summary: "List seller and stock monitor tasks", cost: "free", parameters: [], undocumentedParameters: true,
  },
  {
    name: "ProductSellerTaskUpdate", group: "monitor", command: "seller-update",
    summary: "Update a seller and stock monitor task", cost: "free", parameters: [], undocumentedParameters: true, unsafeRetry: true,
  },
  {
    name: "ProductSellerTaskScheduleList", group: "monitor", command: "seller-runs",
    summary: "List seller/stock monitor execution batches", cost: "free",
    parameters: [p("TaskId", "string", "Seller monitor task ID", { required: true })],
  },
  {
    name: "ProductSellerTaskScheduleDetail", group: "monitor", command: "seller-run-data",
    summary: "Fetch seller/stock monitor execution details", cost: "free", parameters: [scheduleId()],
  },
  {
    name: "ASINSubscription", group: "monitor", command: "asin-update",
    summary: "Add or remove daily ASIN update subscriptions", cost: "1 point/successful update; JP 2",
    parameters: [p("Asins", "string", "Subscription expression: +/-,ASIN,1 (max 100 ASINs)", { required: true })],
    unsafeRetry: true,
  },
  {
    name: "ASINSubscriptionQuery", group: "monitor", command: "asin-list",
    summary: "List active ASIN update subscriptions", cost: "free", parameters: [],
  },
  {
    name: "ASINSubscriptionCollection", group: "monitor", command: "asin-data",
    summary: "Fetch updated data for active ASIN subscriptions", cost: "free",
    parameters: [p("Asins", "string", "Comma-separated subscribed ASINs (max 100)", { required: true })],
  },

  {
    name: "ProductAssistant", group: "agent", command: "product",
    summary: "Start AI analysis for a product", cost: "25 requests",
    parameters: [asin("Asin"), p("Type", "integer", "0 Markdown text; 1 text plus HTML graphics", { required: true, choices: [0, 1] })],
    unsafeRetry: true,
  },
  {
    name: "CategoryAssistant", group: "agent", command: "category",
    summary: "Start AI analysis for a category", cost: "25 requests",
    parameters: [nodeId(), p("Type", "integer", "0 Markdown text; 1 text plus HTML graphics", { required: true, choices: [0, 1] })],
    unsafeRetry: true,
  },
  {
    name: "AIResultQuery", group: "agent", command: "status",
    summary: "List AI tasks and execution progress", cost: "1 request",
    parameters: [
      p("Method", "integer", "0 product analysis; 1 category analysis", { required: true, choices: [0, 1] }),
      p("Params", "string", "ASIN or NodeId filter"),
      p("QueryStart", "string", "Range start (YYYY-MM-DD; max 7 days)", { format: "date" }),
      p("QueryEnd", "string", "Range end (YYYY-MM-DD)", { format: "date" }),
    ],
  },
  {
    name: "AIResult", group: "agent", command: "result",
    summary: "Fetch a completed AI analysis result", cost: "free", parameters: [taskId()],
  },

  {
    name: "CoinQuery", group: "account", command: "coins",
    summary: "Show the account's global coin balance", cost: "free", parameters: [],
  },
  {
    name: "CoinStream", group: "account", command: "coin-stream",
    summary: "Fetch coin usage details for a marketplace", cost: "free",
    parameters: [
      p("QueryDate", "string[]", "Date range: --query-date START --query-date END", { variadic: true }), pageIndex(), pageSize(),
    ],
    pagination: { pageKey: "PageIndex", pageSizeKey: "PageSize", defaultPageSize: 20 },
  },
  {
    name: "RequestStreamMonth", group: "account", command: "request-stream",
    summary: "Show monthly request balance and recent usage", cost: "free", parameters: [],
  },
];

export function findEndpoint(name: string): EndpointSpec | undefined {
  const normalized = name.toLowerCase();
  const exact = ENDPOINTS.find(
    (endpoint) => endpoint.name.toLowerCase() === normalized
      || endpoint.aliases?.some((alias) => alias.toLowerCase() === normalized),
  );
  if (exact) return exact;
  const commandMatches = ENDPOINTS.filter((endpoint) => endpoint.command.toLowerCase() === normalized);
  return commandMatches.length === 1 ? commandMatches[0] : undefined;
}
