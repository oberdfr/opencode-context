/**
 * Shared context report contract.
 *
 * The server plugin registers this and the TUI half calls it, so both halves
 * import the same definition and the report shape has a single source of truth.
 *
 * The two confidence fields are the important part of this shape. `exact` says
 * the total is the provider's own count; `tokenized` says the breakdown came
 * from a real tokenizer. They are independent, and a report can be exact in
 * one and not the other, so the dialog distinguishes them rather than
 * collapsing them into a single "accurate" claim.
 */

import { Rpc } from "@opencode/plugin/rpc";

/** One bucket of the prompt, in display order. */
export type ContextCategory = "system" | "tools" | "mcp" | "memory" | "skills" | "environment" | "messages";

export const CONTEXT_CATEGORIES: readonly ContextCategory[] = [
  "system",
  "tools",
  "mcp",
  "memory",
  "skills",
  "environment",
  "messages",
];

export const CONTEXT_CATEGORY_LABELS: Record<ContextCategory, string> = {
  system: "System prompt",
  tools: "Tools",
  mcp: "MCP tools",
  memory: "Memory files",
  skills: "Skills",
  environment: "Environment",
  messages: "Messages",
};

export interface ContextItem {
  /** Path or identifier, as spelled in the prompt. */
  name: string;
  tokens: number;
  /** True when the tool came from an MCP server. */
  mcp?: boolean;
  /** Which MCP server provided the tool. */
  server?: string;
}

export interface ContextReport {
  generatedAt: number;
  /** Provider and model the window belongs to, e.g. `anthropic/claude-sonnet-5`. */
  model?: string;
  /** Tokens the model is occupying the window with. */
  used: number;
  /** The model's context window. */
  limit: number;
  /**
   * Whether `used` came from the provider's own usage report.
   *
   * When false it is the plugin's own measurement, which is close but not
   * authoritative.
   */
  exact: boolean;
  /**
   * Whether the per-category figures came from a real tokenizer.
   *
   * False means the parts were apportioned by character weight — a defensible
   * approximation, and labelled as one.
   */
  tokenized: boolean;
  /** Name of the tokenizer used, shown so the source is visible. */
  tokenizer?: string;
  categories: Partial<Record<ContextCategory, number>>;
  memoryFiles: ContextItem[];
  skills: ContextItem[];
  /** Token cost per tool, largest first. */
  tools: ContextItem[];
  /** Headroom kept free for compaction. */
  compactionBuffer?: number;
  /** Context usage at which OpenCode compacts. */
  compactionThreshold?: number;
  /** Tokens the provider counted that fall outside the measured categories. */
  unattributed?: number;
  /** Non-fatal problems, such as a session that has not run yet. */
  notes: string[];
}

const itemSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    tokens: { type: "number" },
    mcp: { type: "boolean" },
    server: { type: "string" },
  },
  required: ["name", "tokens"],
  additionalProperties: false,
} as const;

const categorySchema = {
  type: "object",
  properties: {
    system: { type: "number" },
    tools: { type: "number" },
    mcp: { type: "number" },
    memory: { type: "number" },
    skills: { type: "number" },
    environment: { type: "number" },
    messages: { type: "number" },
  },
  additionalProperties: false,
} as const;

export const ContextRpc = Rpc.define({
  id: "context",
  methods: {
    report: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          generatedAt: { type: "number" },
          model: { type: "string" },
          used: { type: "number" },
          limit: { type: "number" },
          exact: { type: "boolean" },
          tokenized: { type: "boolean" },
          tokenizer: { type: "string" },
          categories: categorySchema,
          memoryFiles: { type: "array", items: itemSchema },
          skills: { type: "array", items: itemSchema },
          tools: { type: "array", items: itemSchema },
          compactionBuffer: { type: "number" },
          compactionThreshold: { type: "number" },
          unattributed: { type: "number" },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["generatedAt", "used", "limit", "exact", "tokenized", "categories", "memoryFiles", "skills", "tools", "notes"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseItems(value: unknown): ContextItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const name = optionalString(record?.name);
    const tokens = optionalNumber(record?.tokens);
    if (name === undefined || tokens === undefined) return [];
    const mcp = record?.mcp === true;
    const server = optionalString(record?.server);
    return [{ name, tokens, ...(mcp ? { mcp: true } : {}), ...(server ? { server } : {}) }];
  });
}

/**
 * Narrows an RPC response into a `ContextReport`.
 *
 * JSON Schema inputs and outputs are typed `unknown` and the value arrives over
 * the wire, so the shape is verified rather than asserted. A response that
 * fails validation yields an empty report, which the renderer already handles.
 */
export function parseContextReport(value: unknown): ContextReport {
  const record = asRecord(value);
  const rawCategories = asRecord(record?.categories) ?? {};
  const categories: Partial<Record<ContextCategory, number>> = {};
  for (const key of CONTEXT_CATEGORIES) {
    const tokens = optionalNumber(rawCategories[key]);
    if (tokens !== undefined) categories[key] = tokens;
  }

  const compactionBuffer = optionalNumber(record?.compactionBuffer);
  const compactionThreshold = optionalNumber(record?.compactionThreshold);
  const unattributed = optionalNumber(record?.unattributed);
  const tokenizer = optionalString(record?.tokenizer);

  return {
    generatedAt: optionalNumber(record?.generatedAt) ?? Date.now(),
    ...(optionalString(record?.model) ? { model: optionalString(record?.model)! } : {}),
    used: optionalNumber(record?.used) ?? 0,
    limit: optionalNumber(record?.limit) ?? 0,
    exact: record?.exact === true,
    tokenized: record?.tokenized === true,
    ...(tokenizer ? { tokenizer } : {}),
    categories,
    memoryFiles: parseItems(record?.memoryFiles),
    skills: parseItems(record?.skills),
    tools: parseItems(record?.tools),
    ...(compactionBuffer !== undefined ? { compactionBuffer } : {}),
    ...(compactionThreshold !== undefined ? { compactionThreshold } : {}),
    ...(unattributed !== undefined ? { unattributed } : {}),
    notes: Array.isArray(record?.notes) ? record.notes.filter((note): note is string => typeof note === "string") : [],
  };
}
