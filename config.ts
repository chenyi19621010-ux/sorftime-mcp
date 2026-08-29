import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ValidationError } from "./errors.js";
import type { StoredConfig } from "./types.js";

const execFile = promisify(execFileCallback);
const KEYCHAIN_SERVICE = "com.sorftime.cli";
const KEYCHAIN_ACCOUNT = "account-sk";

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.SORFTIME_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sorftime");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDirectory(env), "config.json");
}

function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDirectory(env), "credentials.json");
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) throw new ValidationError(`Invalid JSON in ${path}: ${error.message}`);
    throw error;
  }
}

const OUTPUT_FORMATS = new Set(["json", "jsonl", "yaml", "csv", "table", "raw"]);
const SECRET_CONFIG_KEY = /(authorization|token|secret|password|account[-_]?sk)/iu;

function normalizeStoredConfig(value: unknown): StoredConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Sorftime config must be a JSON object.");
  }
  const raw = value as Record<string, unknown>;
  const secretKey = Object.keys(raw).find((key) => SECRET_CONFIG_KEY.test(key));
  if (secretKey) {
    throw new ValidationError(`Secret-like key '${secretKey}' is not allowed in config.json. Remove it and use 'sorftime auth login'.`);
  }

  const config: StoredConfig = {};
  if (raw.domain !== undefined) {
    if (typeof raw.domain !== "string" && typeof raw.domain !== "number") throw new ValidationError("Config domain must be a string or number.");
    config.domain = raw.domain;
  }
  if (raw.baseUrl !== undefined) {
    if (typeof raw.baseUrl !== "string") throw new ValidationError("Config baseUrl must be a string.");
    config.baseUrl = raw.baseUrl;
  }
  if (raw.timeoutMs !== undefined) {
    if (!Number.isInteger(raw.timeoutMs) || (raw.timeoutMs as number) <= 0) throw new ValidationError("Config timeoutMs must be a positive integer.");
    config.timeoutMs = raw.timeoutMs as number;
  }
  if (raw.output !== undefined) {
    if (typeof raw.output !== "string" || !OUTPUT_FORMATS.has(raw.output)) throw new ValidationError("Config output format is invalid.");
    config.output = raw.output as NonNullable<StoredConfig["output"]>;
  }
  return config;
}

async function atomicWriteJson(path: string, value: unknown, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
  await chmod(path, mode);
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<StoredConfig> {
  return normalizeStoredConfig(await readJsonFile<unknown>(configPath(env), {}));
}

export async function saveConfig(config: StoredConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await atomicWriteJson(configPath(env), normalizeStoredConfig(config), 0o600);
}

export async function updateConfig(
  patch: Partial<StoredConfig>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredConfig> {
  const next = { ...(await loadConfig(env)), ...patch };
  for (const key of Object.keys(next) as (keyof StoredConfig)[]) {
    if (next[key] === undefined) delete next[key];
  }
  await saveConfig(next, env);
  return next;
}

async function hasSecurityCommand(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (process.platform !== "darwin" || env.SORFTIME_CREDENTIAL_STORE === "file") return false;
  try {
    await access("/usr/bin/security", constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readKeychainToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!(await hasSecurityCommand(env))) return undefined;
  try {
    const { stdout } = await execFile("/usr/bin/security", [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readFileToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const credentials = await readJsonFile<{ accountSk?: string }>(credentialsPath(env), {});
  return credentials.accountSk?.trim() || undefined;
}

export type TokenSource = "flag" | "environment" | "keychain" | "file" | "missing";

export async function resolveToken(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token?: string; source: TokenSource }> {
  if (explicit?.trim()) return { token: explicit.trim(), source: "flag" };
  if (env.SORFTIME_ACCOUNT_SK?.trim()) return { token: env.SORFTIME_ACCOUNT_SK.trim(), source: "environment" };
  const keychain = await readKeychainToken(env);
  if (keychain) return { token: keychain, source: "keychain" };
  const file = await readFileToken(env);
  if (file) return { token: file, source: "file" };
  return { source: "missing" };
}

export async function saveToken(token: string, env: NodeJS.ProcessEnv = process.env): Promise<"keychain" | "file"> {
  const cleaned = token.trim();
  if (!cleaned) throw new ValidationError("Account-SK cannot be empty.");
  if (/[\r\n]/u.test(cleaned)) throw new ValidationError("Account-SK cannot contain line breaks.");

  await atomicWriteJson(credentialsPath(env), { accountSk: cleaned }, 0o600);
  return "file";
}

export async function deleteToken(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  let deleted = false;
  if (await hasSecurityCommand(env)) {
    try {
      await execFile("/usr/bin/security", [
        "delete-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE,
      ]);
      deleted = true;
    } catch {
      // A missing Keychain item is equivalent to an already logged-out state.
    }
  }
  try {
    await unlink(credentialsPath(env));
    deleted = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return deleted;
}
