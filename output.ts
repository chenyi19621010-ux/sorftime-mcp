import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { apiEnvelopeData } from "./client.js";
import { ValidationError } from "./errors.js";
import type { JsonValue, OutputFormat } from "./types.js";

export interface OutputOptions {
  format: OutputFormat;
  dataOnly?: boolean;
  select?: string;
  compact?: boolean;
  outputFile?: string;
}

function selectPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/u.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object" || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function rowsFromValue(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? item as Record<string, unknown>
        : { value: item },
    );
  }
  if (value && typeof value === "object") {
    return [value as Record<string, unknown>];
  }
  return [{ value }];
}

function cell(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvCell(value: unknown): string {
  const text = cell(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(value: unknown): string {
  const rows = rowsFromValue(value);
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0) return "";
  return [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n");
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function toTable(value: unknown, maximumRows = 200): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.every(([, item]) => !item || typeof item !== "object")) {
      const keyWidth = Math.min(32, Math.max(3, ...entries.map(([key]) => key.length)));
      return entries.map(([key, item]) => `${key.padEnd(keyWidth)}  ${cell(item)}`).join("\n");
    }
  }

  const allRows = rowsFromValue(value);
  const rows = allRows.slice(0, maximumRows);
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0) return "(empty)";
  const widths = columns.map((column) =>
    Math.min(40, Math.max(column.length, ...rows.map((row) => cell(row[column]).length))),
  );
  const line = (items: string[]): string => items.map((item, index) => truncate(item, widths[index] ?? 10).padEnd(widths[index] ?? 10)).join("  ");
  const output = [line(columns), line(widths.map((width) => "-".repeat(width))), ...rows.map((row) => line(columns.map((column) => cell(row[column]))))];
  if (allRows.length > maximumRows) output.push(`… output truncated to ${maximumRows} rows; use --output json or --output-file for full data`);
  return output.join("\n");
}

function toJsonLines(value: unknown): string {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => JSON.stringify(item)).join("\n");
}

export function prepareOutput(value: JsonValue, options: OutputOptions): unknown {
  let selected: unknown = value;
  if (options.dataOnly) {
    const data = apiEnvelopeData(selected);
    if (data !== undefined) selected = data;
  }
  if (options.select) {
    const result = selectPath(selected, options.select);
    if (result === undefined) throw new ValidationError(`Selection '${options.select}' did not match the response.`);
    selected = result;
  }
  return selected;
}

export function serializeOutput(value: unknown, options: OutputOptions): string {
  switch (options.format) {
    case "json": return JSON.stringify(value, null, options.compact ? 0 : 2);
    case "jsonl": return toJsonLines(value);
    case "yaml": return YAML.stringify(value).trimEnd();
    case "csv": return toCsv(value);
    case "table": return toTable(value, options.outputFile ? Number.POSITIVE_INFINITY : 200);
    case "raw": return typeof value === "string" ? value : JSON.stringify(value);
  }
}

export async function writeOutput(value: JsonValue, options: OutputOptions): Promise<void> {
  const prepared = prepareOutput(value, options);
  const serialized = serializeOutput(prepared, options);
  const output = options.format === "raw" ? serialized : `${serialized}\n`;
  if (!options.outputFile || options.outputFile === "-") {
    process.stdout.write(output);
    return;
  }
  const path = resolve(options.outputFile);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, output);
  await rename(temporary, path);
}
