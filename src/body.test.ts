import { describe, expect, it } from "vitest";
import { parseRequestBody } from "./body.ts";

/**
 * Fixtures are the real request shapes, captured from live traffic against each
 * provider family. The plugin's whole reliability claim rests on reading these
 * correctly, and a parser that quietly returns nothing for a shape it has not
 * seen would look identical to an empty context.
 */

const ANTHROPIC = JSON.stringify({
  model: "claude-sonnet-5-5",
  system: [
    { type: "text", text: "You are an AI agent running in OpenCode." },
    { type: "text", text: "Instructions from: /p/AGENTS.md\nProject memory." },
  ],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [
    {
      name: "read",
      description: "Read a file.",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
  stream: true,
  max_tokens: 32000,
});

const CHAT = JSON.stringify({
  model: "gpt-4o",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ],
});

const RESPONSES = JSON.stringify({
  model: "gpt-5",
  instructions: "You are an AI agent running in OpenCode.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", name: "read", arguments: '{"path":"a.ts"}' },
    { type: "function_call_output", output: "file contents" },
  ],
  tools: [
    {
      type: "function",
      name: "read",
      description: "Read a file.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
});

describe("parseRequestBody", () => {
  it("recognises the Anthropic Messages shape", () => {
    const parsed = parseRequestBody(ANTHROPIC);
    expect(parsed.shape).toBe("anthropic");
    expect(parsed.system).toHaveLength(2);
    expect(parsed.messages).toHaveLength(1);
    expect(Object.keys(parsed.tools)).toEqual(["read"]);
    expect(parsed.tools.read?.description).toBe("Read a file.");
    expect(parsed.tools.read?.input).toMatchObject({ type: "object" });
  });

  it("lifts the system message out of a Chat Completions conversation", () => {
    const parsed = parseRequestBody(CHAT);
    expect(parsed.shape).toBe("chat");
    // The system prompt is scaffolding, not conversation.
    expect(parsed.system).toHaveLength(1);
    expect(parsed.system[0]?.text).toContain("You are a helpful assistant.");
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("reads instructions as the system prompt in the Responses shape", () => {
    const parsed = parseRequestBody(RESPONSES);
    expect(parsed.shape).toBe("responses");
    expect(parsed.system[0]?.text).toContain("OpenCode");
  });

  it("keeps tool calls and their results in the conversation", () => {
    const parsed = parseRequestBody(RESPONSES);
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[1]?.text).toContain("read");
    expect(parsed.messages[2]?.text).toContain("file contents");
  });

  it("unwraps a nested function envelope for tools", () => {
    expect(parseRequestBody(CHAT).tools.read?.description).toBe("Read a file.");
    expect(parseRequestBody(RESPONSES).tools.read?.description).toBe("Read a file.");
  });

  it("keeps an unrecognised tool as prompt content rather than dropping it", () => {
    const body = JSON.stringify({ system: [{ type: "text", text: "s" }], tools: [{ something: "else" }] });
    const parsed = parseRequestBody(body);
    // No name, so it is not addressable, but its bytes are still counted.
    expect(Object.keys(parsed.tools)).toHaveLength(0);
    expect(parsed.shape).toBe("anthropic");
  });

  it("reports an unknown shape instead of returning an empty parse", () => {
    const parsed = parseRequestBody(JSON.stringify({ model: "x", stream: true }));
    expect(parsed.shape).toBe("unknown");
  });

  it("survives a body that is not JSON", () => {
    const parsed = parseRequestBody("<html>gateway error</html>");
    expect(parsed.shape).toBe("unknown");
    expect(parsed.system).toEqual([]);
    expect(parsed.messages).toEqual([]);
  });

  it("survives an empty body", () => {
    expect(parseRequestBody("").shape).toBe("unknown");
  });

  it("does not lose non-text content parts", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: "s" }],
      messages: [{ role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "look" }] }],
    });
    const parsed = parseRequestBody(body);
    // The image is represented rather than dropped, so the count does not
    // understate what the model was actually sent.
    expect(parsed.messages[0]?.text).toContain("[image]");
    expect(parsed.messages[0]?.text).toContain("look");
  });

  it("handles a system prompt given as a bare string alongside a system message", () => {
    const body = JSON.stringify({ instructions: "base", messages: [{ role: "user", content: "hi" }] });
    const parsed = parseRequestBody(body);
    expect(parsed.system[0]?.text).toBe("base");
    expect(parsed.messages).toHaveLength(1);
  });
});
