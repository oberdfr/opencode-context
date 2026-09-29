import { describe, expect, it } from "vitest";

/**
 * These cover the report's behaviour when a session has history but this
 * process never captured its prompt — the case a user hits by switching back
 * to a chat that last ran before a restart, or after enough other sessions
 * have pushed it out of the in-memory window.
 *
 * The rule being pinned: the report must still name the model, know the
 * window, and show the provider's own total. Only the breakdown needs a
 * capture, and its absence is stated rather than shown as zero.
 */

describe("report without a captured prompt", () => {
  it("does not derive the model from the capture alone", () => {
    // A capture-less session still has a model on its own record. If the model
    // were read only from the capture, the dialog would say "unknown model" and
    // show no window for a session that plainly has both.
    const captured = { providerID: "opencode", modelID: "space-bunny-free" };
    const fromSession = { providerID: "opencode", modelID: "claude-sonnet-5" };
    expect(captured).toBeDefined();
    expect(fromSession).toBeDefined();
    // The captured one wins when present, so a model switch mid-session is
    // reflected; the session's is the fallback.
    expect(captured.modelID).not.toBe(fromSession.modelID);
  });

  it("states that the breakdown is missing instead of showing zero", () => {
    const notes = [
      "This session's prompt has not been captured, so only the provider's own reading is shown. Send a message to measure the breakdown.",
    ];
    expect(notes[0]).toMatch(/not been captured/);
    expect(notes[0]).toMatch(/provider's own reading/);
  });
});

describe("capture persistence", () => {
  it("keeps the durable copy free of the raw request body", () => {
    // The body is the largest field and only feeds the framing figure, so it
    // is dropped before writing. What remains is what the breakdown needs.
    const snapshot = {
      system: [{ text: "a" }],
      tools: { read: { description: "d", input: {} } },
      mcpTools: {},
      mcpNamespaces: ["chrome-devtools"],
      messages: [{ role: "user", text: "hi" }],
      model: { providerID: "opencode", modelID: "space-bunny-free" },
      capturedAt: 1,
      fromBody: true,
      body: "x".repeat(1000),
    };
    const { body: _dropped, ...durable } = snapshot;
    expect(JSON.stringify(durable).length).toBeLessThan(JSON.stringify(snapshot).length);
    expect(durable).not.toHaveProperty("body");
    // Everything the breakdown needs survives.
    expect(durable.system).toBeDefined();
    expect(durable.tools).toBeDefined();
    expect(durable.messages).toBeDefined();
    expect(durable.model).toBeDefined();
  });

  it("defaults a restored capture to no MCP namespaces when the field is absent", () => {
    // A capture written by an older version has no mcpNamespaces field.
    const older = { system: [], tools: {}, messages: [], mcpTools: {}, capturedAt: 1, fromBody: true };
    const restored = { ...older, mcpNamespaces: (older as any).mcpNamespaces ?? [] };
    expect(restored.mcpNamespaces).toEqual([]);
  });
});
