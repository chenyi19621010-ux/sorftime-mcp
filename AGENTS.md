# Codex project instructions

This file is the authoritative development guide for coding agents working in this repository. The root `README.md` is written for repository users and operators; it is not a substitute for these instructions.

## Mission

Maintain a governed Sorftime data service with one deterministic API core and three adapters:

- MCP is the team-facing execution, identity, audit, rate-limit, and policy boundary;
- the Sorftime Research Skill is the Host-side routing and interpretation protocol;
- the CLI is the administrator/developer surface for complete endpoint access, diagnostics, batch work, and emergency operations.

Probabilistic language understanding must end before endpoint authorization and execution begin.

## Start here

Read the smallest relevant set before changing code:

- architecture or adapter boundaries: `docs/architecture.md`;
- MCP/Skill behavior: `docs/mcp-skill-integration.md` and `skills/sorftime-research/SKILL.md`;
- deployment, authentication, secrets, or production readiness: `docs/deployment.md`;
- endpoint contracts: `src/endpoints.ts` and `src/core/governance.ts`;
- MCP tools: `src/mcp/server.ts`;
- CLI behavior: `README.md` and `src/cli.ts`.

## Compatibility baseline

- package, MCP contract, and governance policy: `1.1.0`;
- endpoint registry: 52 Sorftime endpoints;
- ordinary MCP surface: 4 tools, free and read-only only;
- optional admin MCP surface: 2 free read-only tools;
- optional full-admin MCP surface: 52 fixed endpoint tools, default-off and admin-only;
- Skill: `sorftime-research`, compatible with MCP `1.1.x`;
- runtime: Node.js 20+, TypeScript, MCP SDK v1, Streamable HTTP and stdio.

## Non-negotiable invariants

1. Never commit or print a real Sorftime Account-SK, MCP API key, proxy secret, Authorization header, or raw credential file.
2. `src/core/governance.ts` must classify all 52 endpoints. MCP authorization never parses the human `cost` string.
3. The default MCP policy exposes only `billing=free`, `effect=read`, explicitly allowlisted endpoints.
4. Full-admin tools appear only when `MCP_ENABLE_FULL_API_TOOLS=true` and transport identity role is `admin`. Every tool maps to one fixed endpoint; paid or state-changing calls require explicit confirmation.
5. MCP never exposes an arbitrary endpoint-name `raw_call`. Advanced bodies are allowed only on fixed endpoints whose source schema is incomplete, with strict size/key bounds.
6. User/tenant/role identity comes only from authenticated transport context. Tool inputs must never select or override identity.
7. Stdio has no employee authentication; bind one principal at process launch and document it as local/operator mode.
8. Audit records may contain actor, tenant, tool, endpoint names, marketplace, fingerprints, timing, decision, and outcome. They must not contain complete arguments, keywords, ASIN lists, headers, tokens, or upstream payloads.
9. A free endpoint reporting positive `RequestConsumed` opens the billing circuit. Do not continue automatically.
10. MCP retries remain zero. A lost response must not automatically repeat paid or state-changing work.
11. Preserve exact documented wire casing (`ASIN`, `Asin`, `Asins`, `Querystartdt`). Do not normalize payload keys at the shared-client boundary.
12. Upstream unknown schemas remain JSON. Do not invent field meanings or present missing/unavailable values as zero.
13. Shared quota is account-global, never an employee allowance. Per-person activity comes from MCP audit, not Sorftime balance fields.
14. The Skill must not invoke the CLI, request credentials, invent identifiers, silently substitute stale monitoring for realtime data, infer causality, or repeat confirmed paid/state-changing work automatically.
15. CLI completeness must not weaken MCP policy. CLI and MCP share the API core, not the same public command surface.
16. HTTP production/non-loopback mode must authenticate, restrict Hosts, validate Origins when present, cap sessions/concurrency, and keep the Account-SK server-side.
17. MCP output and errors must remain sanitized. Unexpected upstream payloads never appear in public error details.
18. Do not add experimental MCP Tasks for Sorftime async APIs until ownership, identity binding, TTL, persistence, and polling policy are designed and tested.

## Module ownership

```text
src/core/service.ts              Shared Sorftime API execution core
src/core/governance.ts           Exhaustive machine authorization classification
src/client.ts                    Low-level HTTP/envelope/timeout/size handling
src/endpoints.ts                 Complete CLI endpoint/parameter registry
src/mcp/config.ts                Fail-closed runtime and identity configuration
src/mcp/auth.ts                  HTTP identity derivation
src/mcp/audit.ts                 Privacy-preserving audit sink
src/mcp/rate-limit.ts            Per-identity/global local limiter
src/mcp/executor.ts              Policy, audit, billing circuit, unified result
src/mcp/server.ts                Transport-independent public tool schemas
src/mcp/http-server.ts           HTTP auth/origin/host/session lifecycle
src/mcp/http.ts                  Thin HTTP entrypoint
src/mcp/stdio.ts                 Thin stdio entrypoint; stdout is protocol-only
src/cli.ts + src/runner.ts       Full operator CLI adapter
skills/sorftime-research/        Host routing and interpretation Skill
test/                             CLI, core, governance, MCP, HTTP, Skill contracts
```

Do not make MCP shell out to the CLI. Do not duplicate endpoint HTTP logic inside a tool handler.

## Change workflow

1. Inspect the worktree and preserve unrelated user changes.
2. Identify which public boundary changes: core, CLI, governance, MCP schema, identity, Skill, or documentation.
3. Implement the smallest coherent change.
4. Update tests at the same boundary:
   - endpoint/core: client, input, endpoint and CLI regression tests;
   - governance: exhaustive `mcp-governance` tests;
   - tools/output: official SDK `mcp-contract` tests;
   - auth/session/runtime: config and `mcp-http` tests;
   - Skill: `skill-contract`, evals, and `quick_validate.py`.
5. Update README for user behavior and AGENTS/Skill references for invariant/workflow changes.
6. Run `pnpm check`, the Skill validator, secret scan, packaged CLI smoke, packaged MCP stdio smoke, and Docker build when available.
7. Live checks may call only documented free read-only endpoints and must suppress account values.

## MCP and Skill lockstep

When a tool name, selector, result field, error code, policy, admin boundary, or interpretation rule changes:

- update runtime code and strict schema;
- update `skills/sorftime-research/SKILL.md` or its selected reference;
- update Skill evals and contract tests;
- update `docs/mcp-skill-integration.md` and README if operator/user behavior changes.

The Skill must discover uncertain runtime capabilities. It must not become a second executable endpoint registry.

## Validation

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check
```

Skill validation:

```bash
python3 /path/to/skill-creator/scripts/quick_validate.py skills/sorftime-research
pnpm exec vitest run test/skill-contract.test.ts test/mcp-contract.test.ts
```

## Review checklist

- Do ordinary reader tools remain free and read-only, and do full tools require both explicit enablement and admin identity?
- Can an argument influence endpoint selection outside a fixed route?
- Does role/tenant come only from transport auth?
- Could any secret or complete input enter output, logs, audit, fixtures, docs, or git?
- Are schema objects strict and bounded?
- Does cancellation reach the upstream fetch?
- Are empty, unavailable, forbidden, and zero distinct?
- Do MCP, Skill, README, examples, tests, and policy classification agree?
- Do all 52 full-admin tools map to fixed catalog endpoints without arbitrary endpoint-name passthrough?

## Git and release

- Keep commits scoped and descriptive.
- Never commit `.env`, `var/audit.jsonl`, credential files, `dist`, coverage, raw API output, or internal gateway addresses.
- Before pushing, run `git diff --check`, `pnpm check`, Skill validation, packaging smoke, and a token-value scan against the source note without printing the token.
- A passing local build does not prove team deployment is ready. Company gateway/OIDC configuration, secret manager, shared rate/audit storage for replicas, TLS, retention, monitoring, and backup remain deployment responsibilities.
