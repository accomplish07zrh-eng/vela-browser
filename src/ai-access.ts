import { folderScope, type FolderInfo } from "./folders.ts";

/**
 * Which profiles each AI may use, by group. An AI is known by the name its MCP client gives when it
 * connects (Claude, Cursor, Codex…). That name is the client's own word: this keeps one assistant
 * out of another's accounts by mistake, not a hostile program on the same computer.
 */
export type AiAccessRule = "all" | "none" | string[];
export interface AiAccessSettings { default: AiAccessRule; agents: Record<string, AiAccessRule> }

export const AI_ACCESS_DEFAULT: AiAccessSettings = { default: "all", agents: {} };
const UNGROUPED = "";

function normalizeRule(value: unknown): AiAccessRule | undefined {
  if (value === "all" || value === "none") return value;
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 120)))].slice(0, 200);
}

export function agentKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 64) || "unknown";
}

export function normalizeAiAccess(value: unknown): AiAccessSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const agents: Record<string, AiAccessRule> = {};
  if (raw.agents && typeof raw.agents === "object" && !Array.isArray(raw.agents)) {
    for (const [name, rule] of Object.entries(raw.agents).slice(0, 100)) {
      const normalized = normalizeRule(rule);
      if (normalized !== undefined) agents[agentKey(name)] = normalized;
    }
  }
  return { default: normalizeRule(raw.default) ?? "all", agents };
}

export function ruleFor(settings: AiAccessSettings | undefined, agent: string): AiAccessRule {
  const access = settings ?? AI_ACCESS_DEFAULT;
  return access.agents[agentKey(agent)] ?? access.default;
}

/** A group allows its subfolders too; "" stands for profiles without a group. */
export function allowsGroup(rule: AiAccessRule, group: string, folders: readonly FolderInfo[]): boolean {
  if (rule === "all") return true;
  if (rule === "none") return false;
  const target = group.trim();
  for (const allowed of rule) {
    if (allowed === UNGROUPED ? target === UNGROUPED : allowed === target || (target && folderScope(folders, allowed).has(target))) return true;
  }
  return false;
}
