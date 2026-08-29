import { ValidationError } from "./errors.js";

export interface DomainDefinition {
  id: number;
  code: string;
  name: string;
  aliases: readonly string[];
  historyBackfill: boolean;
}

export const DOMAINS: readonly DomainDefinition[] = [
  { id: 1, code: "US", name: "United States", aliases: ["us", "usa", "美国"], historyBackfill: true },
  { id: 2, code: "GB", name: "United Kingdom", aliases: ["gb", "uk", "英国"], historyBackfill: true },
  { id: 3, code: "DE", name: "Germany", aliases: ["de", "germany", "德国"], historyBackfill: true },
  { id: 4, code: "FR", name: "France", aliases: ["fr", "france", "法国"], historyBackfill: true },
  { id: 5, code: "IN", name: "India", aliases: ["in", "india", "印度"], historyBackfill: false },
  { id: 6, code: "CA", name: "Canada", aliases: ["ca", "canada", "加拿大"], historyBackfill: true },
  { id: 7, code: "JP", name: "Japan", aliases: ["jp", "japan", "日本"], historyBackfill: true },
  { id: 8, code: "ES", name: "Spain", aliases: ["es", "spain", "西班牙"], historyBackfill: true },
  { id: 9, code: "IT", name: "Italy", aliases: ["it", "italy", "意大利"], historyBackfill: true },
  { id: 10, code: "MX", name: "Mexico", aliases: ["mx", "mexico", "墨西哥"], historyBackfill: true },
  { id: 11, code: "AE", name: "United Arab Emirates", aliases: ["ae", "uae", "阿联酋"], historyBackfill: false },
  { id: 12, code: "AU", name: "Australia", aliases: ["au", "australia", "澳大利亚"], historyBackfill: false },
  { id: 13, code: "BR", name: "Brazil", aliases: ["br", "brazil", "巴西"], historyBackfill: false },
  { id: 14, code: "SA", name: "Saudi Arabia", aliases: ["sa", "ksa", "saudi", "沙特阿拉伯"], historyBackfill: false },
];

export function resolveDomain(input: string | number | undefined): DomainDefinition {
  const value = String(input ?? "us").trim().toLowerCase();
  const numeric = Number(value);
  const domain = DOMAINS.find(
    (item) => item.id === numeric || item.code.toLowerCase() === value || item.aliases.includes(value),
  );
  if (!domain) {
    throw new ValidationError(`Unsupported domain '${String(input)}'. Run 'sorftime domains' to list valid values.`);
  }
  return domain;
}
