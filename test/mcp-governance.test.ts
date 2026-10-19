import { describe, expect, it } from "vitest";
import { ENDPOINT_GOVERNANCE, validateGovernanceCatalog } from "../src/core/governance.js";
import { ENDPOINTS } from "../src/endpoints.js";

describe("MCP endpoint governance", () => {
  it("classifies all 52 endpoints exactly once", () => {
    expect(() => validateGovernanceCatalog()).not.toThrow();
    expect(Object.keys(ENDPOINT_GOVERNANCE)).toHaveLength(52);
    expect(new Set(ENDPOINTS.map((endpoint) => endpoint.name))).toEqual(new Set(Object.keys(ENDPOINT_GOVERNANCE)));
  });

  it("keeps reader/admin endpoints free and read-only and gates paid or mutating endpoints behind full admin", () => {
    const exposed = Object.entries(ENDPOINT_GOVERNANCE).filter(([, policy]) => policy.exposure !== "full_admin");
    expect(exposed.length).toBeGreaterThan(0);
    for (const [, policy] of exposed) {
      expect(policy.billing).toBe("free");
      expect(policy.effect).toBe("read");
    }
    for (const name of ["ProductRequest", "ProductQuery", "CategoryAssistant", "KeywordBatchSubscription", "BestSellerListDelete", "ASINSubscription"]) {
      expect(ENDPOINT_GOVERNANCE[name]?.exposure).toBe("full_admin");
    }
  });
});
