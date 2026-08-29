import { ENDPOINTS } from "../endpoints.js";
import { ValidationError } from "../errors.js";

export type BillingKind = "free" | "request" | "coin" | "recurring_coin" | "unknown";
export type EndpointEffect = "read" | "create" | "update" | "delete";
export type EndpointExposure = "reader" | "admin" | "full_admin";

export interface EndpointGovernance {
  billing: BillingKind;
  effect: EndpointEffect;
  exposure: EndpointExposure;
  reason: string;
}

const fullAdminRead = (billing: BillingKind, reason = "Available only in explicitly enabled full-admin MCP mode"): EndpointGovernance => ({
  billing, effect: "read", exposure: "full_admin", reason,
});
const fullAdminWrite = (billing: BillingKind, effect: Exclude<EndpointEffect, "read">): EndpointGovernance => ({
  billing, effect, exposure: "full_admin", reason: "Available only in explicitly enabled full-admin MCP mode with confirmation",
});
const reader = (reason = "Free read-only endpoint approved for governed team access"): EndpointGovernance => ({
  billing: "free", effect: "read", exposure: "reader", reason,
});
const admin = (reason: string): EndpointGovernance => ({ billing: "free", effect: "read", exposure: "admin", reason });

/** Exhaustive machine policy. Never infer authorization from the human-readable `cost` field. */
export const ENDPOINT_GOVERNANCE: Readonly<Record<string, EndpointGovernance>> = {
  CategoryTree: fullAdminRead("request"),
  CategoryRequest: fullAdminRead("request"),
  CategoryProducts: fullAdminRead("request"),
  CategoryTrend: fullAdminRead("request"),
  ProductRequest: fullAdminRead("request"),
  ProductQuery: fullAdminRead("request"),
  AsinSalesVolume: fullAdminRead("request"),
  ProductVariationHistory: fullAdminRead("request"),
  ProductRealtimeRequest: fullAdminWrite("request", "create"),
  ProductRealtimeRequestStatusQuery: fullAdminRead("request"),
  ProductReviewsCollection: fullAdminWrite("coin", "create"),
  ProductReviewsCollectionStatusQuery: admin("Existing review-task status is account-level shared data"),
  ProductReviewsQuery: fullAdminRead("request"),
  SimilarProductRealtimeRequest: fullAdminWrite("request", "create"),
  SimilarProductRealtimeRequestStatusQuery: admin("Existing image-search task status is account-level shared data"),
  SimilarProductRealtimeRequestCollection: admin("Existing image-search results require an administrator-provided task ID"),
  KeywordQuery: fullAdminRead("request"),
  KeywordSearchResults: fullAdminRead("request"),
  KeywordRequest: fullAdminRead("request"),
  KeywordSearchResultTrend: fullAdminRead("request"),
  CategoryRequestKeyword: fullAdminRead("request"),
  ASINRequestKeyword: fullAdminRead("request"),
  KeywordProductRanking: fullAdminRead("request"),
  ASINKeywordRanking: fullAdminRead("request"),
  KeywordExtends: fullAdminRead("request"),
  FavoriteKeyword: fullAdminWrite("request", "create"),
  ChangeFavoriteKeyword: fullAdminWrite("request", "update"),
  GetFavoriteKeyword: fullAdminRead("unknown", "Undocumented cost and request schema; full-admin confirmation required"),
  KeywordBatchSubscription: fullAdminWrite("recurring_coin", "create"),
  KeywordTasks: reader(),
  KeywordBatchTaskUpdate: fullAdminWrite("free", "update"),
  KeywordBatchScheduleList: reader(),
  KeywordBatchScheduleDetail: reader(),
  BestSellerListSubscription: fullAdminWrite("recurring_coin", "create"),
  BestSellerListTask: reader(),
  BestSellerListDelete: fullAdminWrite("free", "delete"),
  BestSellerListDataCollect: reader(),
  ProductSellerSubscription: fullAdminWrite("recurring_coin", "create"),
  ProductSellerTasks: admin("Request schema is undocumented; administrator-only experimental read"),
  ProductSellerTaskUpdate: fullAdminWrite("free", "update"),
  ProductSellerTaskScheduleList: reader(),
  ProductSellerTaskScheduleDetail: reader(),
  ASINSubscription: fullAdminWrite("recurring_coin", "update"),
  ASINSubscriptionQuery: reader(),
  ASINSubscriptionCollection: reader(),
  ProductAssistant: fullAdminWrite("request", "create"),
  CategoryAssistant: fullAdminWrite("request", "create"),
  AIResultQuery: fullAdminRead("request"),
  AIResult: admin("Existing AI result requires an administrator-provided task ID"),
  CoinQuery: reader("Global shared-account coin balance"),
  CoinStream: admin("Detailed shared-account coin usage may expose operational activity"),
  RequestStreamMonth: reader("Global shared-account request balance and recent usage summary"),
};

export function validateGovernanceCatalog(): void {
  const endpointNames = new Set(ENDPOINTS.map((endpoint) => endpoint.name));
  const policyNames = new Set(Object.keys(ENDPOINT_GOVERNANCE));
  const missing = [...endpointNames].filter((name) => !policyNames.has(name));
  const extra = [...policyNames].filter((name) => !endpointNames.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new ValidationError(`Endpoint governance catalog mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`);
  }
}

export function governanceFor(endpoint: string): EndpointGovernance {
  const governance = ENDPOINT_GOVERNANCE[endpoint];
  if (!governance) throw new ValidationError(`Endpoint '${endpoint}' has no governance classification.`);
  return governance;
}
