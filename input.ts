import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { stdin } from "node:process";
import { ValidationError } from "./errors.js";
import type { EndpointSpec, JsonObject, JsonValue, ParameterSpec } from "./types.js";

const MAX_JSON_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function optionName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase();
}

export function commanderProperty(key: string): string {
  const name = optionName(key);
  return name.replace(/-([a-z])/gu, (_, character: string) => character.toUpperCase());
}

async function readLimitedFile(path: string): Promise<string> {
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  if (metadata.size > MAX_JSON_BYTES) {
    throw new ValidationError(`Input file exceeds the ${MAX_JSON_BYTES / 1024 / 1024}MB limit.`);
  }
  const buffer = await readFile(absolute);
  return buffer.toString("utf8");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_JSON_BYTES) throw new ValidationError(`Standard input exceeds the ${MAX_JSON_BYTES / 1024 / 1024}MB limit.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonObject(text: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must contain a JSON object.`);
  }
  return value as JsonObject;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validateFormat(value: string, parameter: ParameterSpec): void {
  if (parameter.format === "date" && !validDate(value)) {
    throw new ValidationError(`--${optionName(parameter.key)} must be a valid date in YYYY-MM-DD format.`);
  }
  if (parameter.format === "month" && !/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) {
    throw new ValidationError(`--${optionName(parameter.key)} must use YYYY-MM format.`);
  }
  if (parameter.format === "date-hour") {
    const match = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3])$/u.exec(value);
    if (!match?.[1] || !validDate(match[1])) {
      throw new ValidationError(`--${optionName(parameter.key)} must use YYYY-MM-DD HH format.`);
    }
  }
}

function parseNumber(value: unknown, integer: boolean, parameter: ParameterSpec): number {
  if (typeof value === "number") {
    if (integer && !Number.isInteger(value)) throw new ValidationError(`${parameter.key} must be an integer.`);
    return value;
  }
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${parameter.key} must be a number.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw new ValidationError(`${parameter.key} must be ${integer ? "an integer" : "a number"}.`);
  }
  return parsed;
}

function mimeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  return ({
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

async function coerceValue(raw: unknown, parameter: ParameterSpec): Promise<JsonValue> {
  if (parameter.type === "integer" || parameter.type === "number") {
    const value = parseNumber(raw, parameter.type === "integer", parameter);
    if (parameter.min !== undefined && value < parameter.min) {
      throw new ValidationError(`${parameter.key} must be at least ${parameter.min}.`);
    }
    if (parameter.max !== undefined && value > parameter.max) {
      throw new ValidationError(`${parameter.key} must be at most ${parameter.max}.`);
    }
    if (parameter.choices && !parameter.choices.includes(value)) {
      throw new ValidationError(`${parameter.key} must be one of: ${parameter.choices.join(", ")}.`);
    }
    return value;
  }
  if (parameter.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    const value = String(raw).toLowerCase();
    if (["true", "1", "yes"].includes(value)) return true;
    if (["false", "0", "no"].includes(value)) return false;
    throw new ValidationError(`${parameter.key} must be true or false.`);
  }
  if (parameter.type === "string[]") {
    const values = Array.isArray(raw) ? raw : [raw];
    return values.flatMap((value) => String(value).split(",")).map((value) => value.trim()).filter(Boolean);
  }
  if (parameter.type === "json") {
    if (typeof raw !== "string") return raw as JsonValue;
    const text = raw.startsWith("@") ? await readLimitedFile(raw.slice(1)) : raw;
    try {
      return JSON.parse(text) as JsonValue;
    } catch (error) {
      throw new ValidationError(`Invalid JSON for ${parameter.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (parameter.type === "image") {
    const value = String(raw);
    if (!value.startsWith("@")) return value;
    const path = value.slice(1);
    const absolute = resolve(path);
    const metadata = await stat(absolute);
    if (metadata.size > MAX_IMAGE_BYTES) {
      throw new ValidationError(`Image file exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024}MB safety limit.`);
    }
    const buffer = await readFile(absolute);
    return `data:${mimeForPath(path)};base64,${buffer.toString("base64")}`;
  }
  const value = String(raw);
  validateFormat(value, parameter);
  if (parameter.choices && !parameter.choices.includes(value)) {
    throw new ValidationError(`${parameter.key} must be one of: ${parameter.choices.join(", ")}.`);
  }
  return value;
}

export interface BodyInputOptions {
  data?: string;
  dataFile?: string;
  stdin?: boolean;
}

export async function buildRequestBody(
  endpoint: EndpointSpec,
  commandOptions: Record<string, unknown>,
): Promise<JsonObject> {
  const input: BodyInputOptions = {
    ...(typeof commandOptions.data === "string" ? { data: commandOptions.data } : {}),
    ...(typeof commandOptions.dataFile === "string" ? { dataFile: commandOptions.dataFile } : {}),
    ...(commandOptions.stdin === true ? { stdin: true } : {}),
  };
  const rawModes = [input.data !== undefined, input.dataFile !== undefined, input.stdin].filter(Boolean).length;
  if (rawModes > 1) throw new ValidationError("Use only one of --data, --data-file, or --stdin.");

  let body: JsonObject = {};
  if (input.data !== undefined) body = parseJsonObject(input.data, "--data");
  if (input.dataFile !== undefined) body = parseJsonObject(await readLimitedFile(input.dataFile), input.dataFile);
  if (input.stdin) body = parseJsonObject(await readStdin(), "standard input");

  for (const parameter of endpoint.parameters) {
    const raw = commandOptions[commanderProperty(parameter.key)];
    if (raw !== undefined) body[parameter.key] = await coerceValue(raw, parameter);
  }

  for (const parameter of endpoint.parameters) {
    if (parameter.required && (body[parameter.key] === undefined || body[parameter.key] === "")) {
      throw new ValidationError(`Missing required option --${optionName(parameter.key)} (or provide ${parameter.key} in raw JSON).`);
    }
    const value = body[parameter.key];
    if (value !== undefined && (parameter.type === "integer" || parameter.type === "number")) {
      body[parameter.key] = await coerceValue(value, parameter);
    }
    if (value !== undefined && parameter.type === "string" && typeof value === "string") validateFormat(value, parameter);
  }

  validateEndpointBody(endpoint, body);
  return body;
}

function validateEndpointBody(endpoint: EndpointSpec, body: JsonObject): void {
  if (endpoint.name === "ProductRequest" && Array.isArray(body.ASIN) && body.ASIN.length > 10) {
    throw new ValidationError("ProductRequest accepts at most 10 ASINs per call.");
  }
  if (endpoint.name === "ProductQuery" && (body.Query === undefined || body.Query === 1)) {
    if (body.QueryType === undefined || body.Pattern === undefined) {
      throw new ValidationError("ProductQuery single-condition mode requires --query-type and --pattern.");
    }
  }
  if (endpoint.name === "KeywordBatchSubscription" && body.Mode === 0 && !body.Area) {
    throw new ValidationError("Desktop keyword monitoring (--mode 0) requires --area.");
  }
  if (endpoint.name === "CoinStream" && Array.isArray(body.QueryDate) && body.QueryDate.length !== 2) {
    throw new ValidationError("CoinStream --query-date requires exactly two values: start and end.");
  }
  if (endpoint.name === "ProductRequest" && body.QueryTrendEndDt !== undefined && body.QueryTrendStartDt === undefined) {
    throw new ValidationError("--query-trend-end-dt requires --query-trend-start-dt.");
  }
}
