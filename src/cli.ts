#!/usr/bin/env node
import { password } from "@inquirer/prompts";
import { Command, CommanderError, Option } from "commander";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_BASE_URL } from "./client.js";
import { configPath, deleteToken, loadConfig, resolveToken, saveConfig, saveToken } from "./config.js";
import { DOMAINS, resolveDomain } from "./domains.js";
import { ENDPOINTS, findEndpoint } from "./endpoints.js";
import { AuthenticationError, CliError, ValidationError } from "./errors.js";
import { optionName } from "./input.js";
import { runEndpoint } from "./runner.js";
import type { EndpointSpec, GlobalOptions, OutputFormat, StoredConfig } from "./types.js";

const VERSION = "1.1.0";
const rootAbort = new AbortController();

function addBodyOptions(command: Command): void {
  command
    .addOption(new Option("--data <json>", "Raw JSON request body").conflicts(["dataFile", "stdin"]))
    .addOption(new Option("--data-file <path>", "Read the JSON request body from a file").conflicts(["data", "stdin"]))
    .addOption(new Option("--stdin", "Read the JSON request body from standard input").conflicts(["data", "dataFile"]));
}

function optionForParameter(parameter: EndpointSpec["parameters"][number]): Option {
  const flag = `--${optionName(parameter.key)} <value${parameter.type === "string[]" ? "..." : ""}>`;
  const details = [
    parameter.description,
    parameter.required ? "required" : undefined,
    parameter.choices ? `choices: ${parameter.choices.join(", ")}` : undefined,
  ].filter(Boolean).join("; ");
  return new Option(flag, details);
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function addEndpointCommand(parent: Command, endpoint: EndpointSpec): void {
  const command = parent
    .command(endpoint.command)
    .description(`${endpoint.summary} [cost: ${endpoint.cost}]`)
    .summary(endpoint.summary);
  for (const parameter of endpoint.parameters) command.addOption(optionForParameter(parameter));
  addBodyOptions(command);
  if (endpoint.undocumentedParameters) {
    command.addHelpText("after", "\nThe source documentation does not define this endpoint's body schema; use --data, --data-file, or --stdin.");
  }
  command.action(async (_options: unknown, actionCommand: Command) => {
    await runEndpoint(endpoint, actionCommand.opts(), globalOptions(actionCommand), rootAbort.signal);
  });
}

async function stdinToken(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 64 * 1024) throw new ValidationError("Credential input exceeds the 64KB safety limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function validateConfigValue(key: string, value: string): StoredConfig {
  switch (key) {
    case "domain": return { domain: resolveDomain(value).code.toLowerCase() };
    case "base-url": {
      let url: URL;
      try { url = new URL(value); } catch { throw new ValidationError(`Invalid base URL '${value}'.`); }
      if (url.protocol !== "https:") throw new ValidationError("Configured base URL must use HTTPS.");
      return { baseUrl: value.endsWith("/") ? value : `${value}/` };
    }
    case "timeout": {
      const seconds = Number(value);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new ValidationError("timeout must be 1-3600 seconds.");
      return { timeoutMs: seconds * 1000 };
    }
    case "output": {
      const formats: OutputFormat[] = ["json", "jsonl", "yaml", "csv", "table", "raw"];
      if (!formats.includes(value as OutputFormat)) throw new ValidationError(`output must be one of: ${formats.join(", ")}.`);
      return { output: value as OutputFormat };
    }
    case "token": case "account-sk": case "authorization":
      throw new ValidationError("Credentials cannot be stored with config set; use 'sorftime auth login'.");
    default: throw new ValidationError("Config key must be one of: domain, base-url, timeout, output.");
  }
}

function installAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage the Sorftime Account-SK credential");
  auth.command("login")
    .description("Store an Account-SK in a mode-0600 local credential file")
    .option("--token-stdin", "Read the credential from standard input (recommended for scripts)")
    .action(async (options: { tokenStdin?: boolean }) => {
      if (!options.tokenStdin && !process.stdin.isTTY) {
        throw new AuthenticationError("Non-interactive login requires --token-stdin.");
      }
      const token = options.tokenStdin ? await stdinToken() : await password({ message: "Account-SK:" });
      await saveToken(token);
      process.stdout.write("Credential saved to a mode-0600 credential file.\n");
    });
  auth.command("status")
    .description("Show whether a credential is available without revealing it")
    .action(async () => {
      const result = await resolveToken();
      process.stdout.write(result.token ? `Authenticated (source: ${result.source}).\n` : "Not authenticated.\n");
      if (!result.token) process.exitCode = 3;
    });
  auth.command("logout")
    .description("Remove the locally stored credential")
    .action(async () => {
      const deleted = await deleteToken();
      process.stdout.write(deleted ? "Stored credential removed.\n" : "No stored credential found.\n");
    });
}

function installConfigCommands(program: Command): void {
  const config = program.command("config").description("Manage non-secret CLI defaults");
  config.command("list").description("Print all configured defaults").action(async () => {
    process.stdout.write(`${JSON.stringify(await loadConfig(), null, 2)}\n`);
  });
  config.command("path").description("Print the user configuration path").action(() => {
    process.stdout.write(`${configPath()}\n`);
  });
  config.command("get <key>").description("Print one configured value").action(async (key: string) => {
    const current = await loadConfig();
    const patch = validateConfigValue(key, key === "base-url" ? DEFAULT_BASE_URL : key === "domain" ? "us" : key === "timeout" ? "60" : "json");
    const property = Object.keys(patch)[0] as keyof StoredConfig;
    const value = current[property];
    if (value === undefined) throw new ValidationError(`Config key '${key}' is not set.`);
    process.stdout.write(`${String(property === "timeoutMs" ? Number(value) / 1000 : value)}\n`);
  });
  config.command("set <key> <value>").description("Set a non-secret default").action(async (key: string, value: string) => {
    const current = await loadConfig();
    await saveConfig({ ...current, ...validateConfigValue(key, value) });
    process.stdout.write(`Updated ${key}.\n`);
  });
  config.command("unset <key>").description("Remove a configured default").action(async (key: string) => {
    const current = await loadConfig();
    const patch = validateConfigValue(key, key === "base-url" ? DEFAULT_BASE_URL : key === "domain" ? "us" : key === "timeout" ? "60" : "json");
    const property = Object.keys(patch)[0] as keyof StoredConfig;
    delete current[property];
    await saveConfig(current);
    process.stdout.write(`Removed ${key}.\n`);
  });
}

function installUtilityCommands(program: Command): void {
  program.command("domains").description("List supported Amazon marketplace domains").action(() => {
    const rows = DOMAINS.map((domain) => ({
      id: domain.id, code: domain.code, marketplace: domain.name,
      historyBackfill: domain.historyBackfill ? "yes" : "no",
    }));
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  });

  program.command("endpoints")
    .description("List all implemented Sorftime API endpoints")
    .option("--group <group>", "Filter by command group")
    .option("--json", "Emit JSON")
    .action((options: { group?: string; json?: boolean }) => {
      const endpoints = options.group ? ENDPOINTS.filter((item) => item.group === options.group) : ENDPOINTS;
      if (options.group && endpoints.length === 0) throw new ValidationError(`Unknown endpoint group '${options.group}'.`);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(endpoints, null, 2)}\n`);
      } else {
        const lines = endpoints.map((item) => `${item.name.padEnd(45)} ${item.group.padEnd(9)} ${item.command.padEnd(22)} ${item.cost}`);
        process.stdout.write(`ENDPOINT                                      GROUP     COMMAND                COST\n${lines.join("\n")}\n`);
      }
    });

  const api = program.command("api").description("Low-level API access");
  const call = api.command("call <endpoint>").description("Call an endpoint with a raw JSON body");
  addBodyOptions(call);
  call.action(async (endpointName: string, _options: unknown, actionCommand: Command) => {
    const known = findEndpoint(endpointName);
    const commandMatches = ENDPOINTS.filter((endpoint) => endpoint.command.toLowerCase() === endpointName.toLowerCase());
    if (!known && commandMatches.length > 1) {
      throw new ValidationError(`Ambiguous command name '${endpointName}'. Use the exact API endpoint name instead.`);
    }
    const endpoint: EndpointSpec = {
      name: known?.name ?? endpointName,
      group: known?.group ?? "account",
      command: "call",
      summary: known?.summary ?? "Raw API call",
      cost: known?.cost ?? "unknown",
      parameters: [],
      undocumentedParameters: true,
      unsafeRetry: known?.unsafeRetry ?? !known,
    };
    await runEndpoint(endpoint, actionCommand.opts(), globalOptions(actionCommand), rootAbort.signal);
  });
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("sorftime")
    .description("Complete CLI for the Sorftime Enterprise API")
    .version(VERSION)
    .showSuggestionAfterError()
    .showHelpAfterError()
    .option("-d, --domain <domain>", "Amazon marketplace ID/code (default: us)")
    .option("--base-url <url>", "API base URL (default: canonical Sorftime API)")
    .option("--timeout <seconds>", "Request timeout in seconds (1-3600)")
    .option("--retries <count>", "Retry transient transport/HTTP failures (0-5; default: 0)")
    .option("--retry-unsafe", "Allow requested retries for task-creating or mutating endpoints")
    .option("--all-pages", "Fetch and aggregate every page for supported list endpoints")
    .option("--max-pages <count>", "Safety cap for --all-pages (1-1000; default: 100)")
    .option("--page-delay <milliseconds>", "Delay between pages (0-60000; default: 0)")
    .addOption(new Option("-o, --output <format>", "Output format").choices(["json", "jsonl", "yaml", "csv", "table", "raw"]))
    .option("--data-only", "Output only the Data/data field from the response envelope")
    .option("--select <path>", "Select a dot-separated response path")
    .option("--output-file <path>", "Write output atomically to a file")
    .option("--compact", "Emit compact JSON")
    .option("--verbose", "Print safe request diagnostics to stderr (credentials are never printed)")
    .option("--force", "Bypass marketplace history-support guardrails");

  installAuthCommands(program);
  installConfigCommands(program);
  installUtilityCommands(program);
  for (const groupName of ["category", "product", "keyword", "monitor", "agent", "account"] as const) {
    const group = program.command(groupName).description(`${groupName[0]?.toUpperCase()}${groupName.slice(1)} API commands`);
    for (const endpoint of ENDPOINTS.filter((item) => item.group === groupName)) addEndpointCommand(group, endpoint);
  }
  return program;
}

function safeError(error: unknown): { message: string; exitCode: number } {
  if (error instanceof CommanderError) return { message: error.message, exitCode: error.exitCode };
  if (error instanceof CliError) return { message: error.message, exitCode: error.exitCode };
  return { message: error instanceof Error ? error.message : String(error), exitCode: 1 };
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = createProgram().exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    const safe = safeError(error);
    process.stderr.write(`Error: ${safe.message}\n`);
    process.exitCode = safe.exitCode;
  }
}

process.once("SIGINT", () => {
  rootAbort.abort(new Error("Interrupted"));
  process.exitCode = 130;
});

const invokedPath = process.argv[1];
const isEntrypoint = invokedPath !== undefined && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
if (isEntrypoint) await runCli();
