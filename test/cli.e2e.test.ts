import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

interface RunResult { stdout: string; stderr: string; code: number | null }

function runCli(arguments_: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...arguments_], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

describe("CLI contract", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
  });

  it("prints version and help without treating them as errors", async () => {
    const version = await runCli(["--version"], {});
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(version).toEqual({ stdout: `${manifest.version}\n`, stderr: "", code: 0 });
    const help = await runCli(["product", "--help"], {});
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Commands:");
  });

  it("sends typed flags with exact wire casing and emits Data only", async () => {
    let observed: { url: string | undefined; auth: string | undefined; body: unknown } | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        observed = {
          url: request.url,
          auth: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ Code: 0, Data: [{ ASIN: "B000TEST" }] }));
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    const result = await runCli([
      "--domain", "jp", "--data-only", "--output", "json", "product", "get", "--asin", "B000TEST", "--trend", "2",
    ], {
      SORFTIME_ACCOUNT_SK: "e2e-sentinel-secret",
      SORFTIME_BASE_URL: `http://127.0.0.1:${address.port}/api/`,
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual([{ ASIN: "B000TEST" }]);
    expect(observed).toEqual({
      url: "/api/ProductRequest?domain=7",
      auth: "BasicAuth e2e-sentinel-secret",
      body: { ASIN: ["B000TEST"], Trend: 2 },
    });
    expect(result.stdout + result.stderr).not.toContain("e2e-sentinel-secret");
  });

  it("aggregates documented pagination dialects and stops on a short page", async () => {
    const observedPages: number[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { PageIndex: number };
        observedPages.push(body.PageIndex);
        const rows = body.PageIndex === 1
          ? Array.from({ length: 20 }, (_, index) => ({ id: index + 1 }))
          : [{ id: 21 }];
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ Code: 0, Data: rows }));
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    const result = await runCli([
      "--all-pages", "--output", "json", "keyword", "list", "--page-size", "20",
    ], {
      SORFTIME_ACCOUNT_SK: "pagination-sentinel",
      SORFTIME_BASE_URL: `http://127.0.0.1:${address.port}/api/`,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(observedPages).toEqual([1, 2]);
    const output = JSON.parse(result.stdout) as { Data: unknown[]; _pagination: { pagesFetched: number } };
    expect(output.Data).toHaveLength(21);
    expect(output._pagination.pagesFetched).toBe(2);
  }, 15_000);

  it("blocks retries for mutating endpoints unless explicitly acknowledged", async () => {
    const result = await runCli([
      "--retries", "1", "product", "realtime-start", "--asin", "B000TEST",
    ], { SORFTIME_ACCOUNT_SK: "unsafe-retry-sentinel" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Retry is disabled unless --retry-unsafe");
    expect(result.stdout + result.stderr).not.toContain("unsafe-retry-sentinel");
  });

  it("preserves exact successful response bytes in raw mode", async () => {
    const exact = ` { "Code": 0, "Data": [] }\n`;
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(exact);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const result = await runCli(["--output", "raw", "account", "coins"], {
      SORFTIME_ACCOUNT_SK: "raw-sentinel",
      SORFTIME_BASE_URL: `http://127.0.0.1:${address.port}/api/`,
    });
    expect(result).toEqual({ stdout: exact, stderr: "", code: 0 });
  });
});
