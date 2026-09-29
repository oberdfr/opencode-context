/**
 * Reading a provider's request body.
 *
 * The `session.http.request` hook hands over the exact serialized JSON the
 * provider was given, which is the only place the real prompt can be measured
 * rather than approximated. It is also the only place where the shapes differ
 * wildly between providers, so this module is the one place that has to know
 * about them.
 *
 * Three shapes are handled, all observed on live traffic:
 *
 * - Anthropic Messages: `system` (array of text parts), `messages`, `tools`
 *   with `input_schema`.
 * - OpenAI Chat Completions: `messages` (system role inline), `tools` with
 *   `function.parameters`.
 * - OpenAI Responses: `instructions` (a single string), `input`, and `tools`
 *   with `flat` function wrappers.
 *
 * Anything unrecognised is reported as such rather than silently read as empty,
 * because an empty measurement looks like a real one.
 */

import type { MessageLike, SystemPart, ToolDefinition } from "./measure.ts";

/** A request body, decomposed into the parts a context report needs. */
export interface ParsedBody {
  system: SystemPart[];
  tools: Record<string, ToolDefinition>;
  messages: MessageLike[];
  /** Which shape matched, for diagnostics. */
  shape: "anthropic" | "chat" | "responses" | "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** System text, whatever shape the provider used to carry it. */
function readSystem(payload: Record<string, unknown>): SystemPart[] {
  // Anthropic: an array of `{type:"text", text}` parts.
  if (Array.isArray(payload.system)) {
    return payload.system.flatMap((part) => {
      const text = (part as { text?: unknown } | undefined)?.text;
      return typeof text === "string" ? [{ text }] : [];
    });
  }
  // OpenAI Responses: one flat string.
  if (typeof payload.instructions === "string" && payload.instructions !== "") {
    return [{ text: payload.instructions }];
  }
  // OpenAI Chat: a system message inside `messages`, handled in readMessages.
  return [];
}

/**
 * Messages, whichever key carried them.
 *
 * `instructions` is excluded from the system category in the Chat shape because
 * there it lives as a `system` role message and is picked up here instead.
 */
function readMessages(payload: Record<string, unknown>): MessageLike[] {
  const raw = asArray(payload.messages ?? payload.input);
  return raw.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];

    // OpenAI Responses wraps each turn in `{type, role, content}`; tool calls
    // and results arrive as separate typed items rather than as content parts.
    const type = typeof record.type === "string" ? record.type : undefined;
    const role = typeof record.role === "string" ? record.role : type === "function_call" ? "assistant" : type === "function_call_output" ? "tool" : "user";

    if (type === "function_call") {
      return [{ role, text: `${String(record.name ?? "")}${safeJson(record.arguments)}` }];
    }
    if (type === "function_call_output") {
      return [{ role, text: safeJson(record.output) }];
    }
    if (type === "reasoning") {
      return [{ role: "assistant", text: safeJson(record.summary ?? record.content) }];
    }

    // A system message is prompt scaffolding, not conversation, so it is
    // counted under `system` rather than inflating the message totals.
    if (role === "system" || role === "developer") {
      return [{ role: "system", text: flattenContent(record.content ?? record.text) }];
    }

    return [{ role, text: flattenContent(record.content ?? record.text) }];
  });
}

function safeJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Flattens content to text.
 *
 * Tool results and attachments are part of the prompt even though they are not
 * plain prose, so anything unrecognised falls back to its JSON form rather than
 * being dropped — an undercount here would make the whole breakdown read low.
 */
function flattenContent(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flattenContent).join("\n");
  if (typeof content !== "object") return String(content);

  const record = content as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (record.type === "tool-call" || record.type === "tool_use") return `${String(record.name ?? "")}${safeJson(record.input)}`;
  if (record.type === "tool-result" || record.type === "tool_result") return safeJson(record.content ?? record.output);
  if (record.type === "image" || record.type === "input_image") return "[image]";
  return safeJson(record);
}

/**
 * Tool definitions, unwrapping whichever envelope the provider used.
 *
 * The whole entry is kept as the schema when no schema key is recognised: it is
 * still prompt content the model is charged for, and dropping it would understate
 * the tools bucket.
 */
function readTools(payload: Record<string, unknown>): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {};
  for (const entry of asArray(payload.tools)) {
    const record = asRecord(entry);
    if (!record) continue;

    // OpenAI Responses wraps the tool in a `function` object; Chat nests
    // parameters one level deeper again.
    const fn = asRecord(record.function) ?? asRecord(asRecord(record.function)?.function);
    const name = [record.name, record.tool, fn?.name].find((value) => typeof value === "string" && value !== "") as string | undefined;
    if (!name) continue;

    const schema =
      record.input_schema ??
      record.inputSchema ??
      record.parameters ??
      fn?.parameters ??
      fn?.input_schema ??
      fn?.inputSchema;

    tools[name] = {
      description: String(record.description ?? fn?.description ?? ""),
      input: schema ?? record,
    };
  }
  return tools;
}

/** Decomposes a serialized request body into its prompt parts. */
export function parseRequestBody(body: string): ParsedBody {
  let payload: Record<string, unknown> | undefined;
  try {
    payload = asRecord(JSON.parse(body));
  } catch {
    return { system: [], tools: {}, messages: [], shape: "unknown" };
  }
  if (!payload) return { system: [], tools: {}, messages: [], shape: "unknown" };

  const shape: ParsedBody["shape"] = Array.isArray(payload.system)
    ? "anthropic"
    : typeof payload.instructions === "string"
      ? "responses"
      : Array.isArray(payload.messages)
        ? "chat"
        : Array.isArray(payload.input)
          ? "responses"
          : "unknown";

  const system = readSystem(payload);
  const messages = readMessages(payload);

  // In the Chat shape the system prompt is a message, so those entries are
  // lifted out of the conversation and into the system category.
  let systemParts = system;
  let conversation = messages;
  if (shape === "chat") {
    const scaffolding = messages.filter((message) => message.role === "system");
    if (scaffolding.length > 0) {
      systemParts = [...systemParts, ...scaffolding.map((message) => ({ text: `${message.role}\n${message.text}` }))];
      conversation = messages.filter((message) => message.role !== "system");
    }
  }

  return { system: systemParts, tools: readTools(payload), messages: conversation, shape };
}
