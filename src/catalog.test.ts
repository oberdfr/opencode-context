import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseCatalog } from "./catalog.ts";

/**
 * The fixture is the Code Mode catalogue shape captured from a live OpenCode
 * session, not a hand-written approximation. The namespace grammar is the whole
 * basis for attributing MCP cost, so a fixture that only resembles the real
 * thing would let the parser pass while failing in production.
 */
const FIXTURE = `# Code Mode

Use the \`execute\` tool to call the tools listed below. They cannot be called directly, and neither can \`search\`.

- search({
  query?: string,
}): {
    items: Array<{
      path: string,
    }>,
}

## Available tools

- chrome-devtools (30 tools, 4 shown) // Desktop browser tools. Always target an explicit tabID.
  - tools["chrome-devtools"].close_page({
  /**
   * The ID of the page to close.
   */
  pageId: number,
}): Promise<unknown> // Closes the page by its index.
  - tools["chrome-devtools"].list_pages({
}): Promise<unknown> // Get a list of pages open in the browser.

- open-design (22 tools, 4 shown) // OpenDesign (OD) is a local-first design workspace.
  - tools["open-design"].cancel_run({
  /** Run id returned by start_run. */
  runId: string,
}): Promise<unknown> // Request cancellation of an in-flight run.

- browser (45 tools, 4 shown) // Desktop browser tools.
  - tools.browser.tabs.list({
}): Promise<{
  tabs: Array<{
      id: string,
  }>,
}> // List this session's browser tabs.
`;

/**
 * A capture from a live session, committed alongside the tests.
 *
 * Which namespaces appear depends on which MCP servers were connected at the
 * time, so the assertions against it are invariants rather than specific
 * names — but running the parser over real traffic is what proves the grammar
 * has not drifted from what OpenCode actually emits.
 */
const REAL = (() => {
  try {
    return readFileSync(new URL("./catalog.real.txt", import.meta.url), "utf8");
  } catch {
    return null;
  }
})();

describe("parseCatalog", () => {
  it("recognises a Code Mode catalogue", () => {
    expect(parseCatalog(FIXTURE)).toBeDefined();
  });

  it("returns nothing for text that is not a catalogue", () => {
    expect(parseCatalog("You are an AI agent.")).toBeUndefined();
    expect(parseCatalog("")).toBeUndefined();
  });

  it("finds every namespace header", () => {
    const parsed = parseCatalog(FIXTURE)!;
    const names = parsed.namespaces.map((n) => n.name);
    expect(names).toEqual(["chrome-devtools", "open-design", "browser"]);
  });

  it("reads the tool count from the header", () => {
    const parsed = parseCatalog(FIXTURE)!;
    const devtools = parsed.namespaces.find((n) => n.name === "chrome-devtools")!;
    expect(devtools.total).toBe(30);
    expect(devtools.listed).toBe(4);
  });

  it("attributes each tool to its namespace", () => {
    const parsed = parseCatalog(FIXTURE)!;
    const devtools = parsed.namespaces.find((n) => n.name === "chrome-devtools")!;
    expect(devtools.tools.map((t) => t.path)).toEqual([
      'tools["chrome-devtools"].close_page',
      'tools["chrome-devtools"].list_pages',
    ]);
    expect(devtools.tools.every((t) => t.namespace === "chrome-devtools")).toBe(true);
  });

  it("keeps each tool's full signature, comments included", () => {
    const parsed = parseCatalog(FIXTURE)!;
    const devtools = parsed.namespaces.find((n) => n.name === "chrome-devtools")!;
    const close = devtools.tools[0]!;
    // The schema and the doc comment are prompt content and must survive.
    expect(close.text).toContain("pageId: number");
    expect(close.text).toContain("The ID of the page to close");
    // And it must stop at the next tool rather than swallowing it.
    expect(close.text).not.toContain("list_pages");
  });

  it("does not treat a nested bullet as a top-level namespace", () => {
    const parsed = parseCatalog(FIXTURE)!;
    // A `search({` bullet sits at the top level but is not a namespace header.
    expect(parsed.namespaces.some((n) => n.name === "search")).toBe(false);
  });

  it("keeps the pre-namespace prose as preamble", () => {
    const parsed = parseCatalog(FIXTURE)!;
    expect(parsed.preamble).toContain("# Code Mode");
    expect(parsed.preamble).toContain("Available tools");
    // A namespace's own header must not end up in the preamble.
    expect(parsed.preamble).not.toContain("chrome-devtools (30 tools");
  });

  it("charges each namespace its header", () => {
    const parsed = parseCatalog(FIXTURE)!;
    const devtools = parsed.namespaces.find((n) => n.name === "chrome-devtools")!;
    expect(devtools.text).toContain("chrome-devtools (30 tools");
  });

  it("gives every namespace a line range that does not overlap", () => {
    const parsed = parseCatalog(FIXTURE)!;
    for (let i = 1; i < parsed.namespaces.length; i++) {
      expect(parsed.namespaces[i]!.start).toBeGreaterThanOrEqual(parsed.namespaces[i - 1]!.end);
    }
  });

  it("handles a namespace header with no description", () => {
    const parsed = parseCatalog("# Code Mode\n\n- bare (2 tools)\n  - tools.bare.a({\n}) // x\n")!;
    expect(parsed.namespaces[0]?.name).toBe("bare");
    expect(parsed.namespaces[0]?.description).toBeUndefined();
    expect(parsed.namespaces[0]?.listed).toBe(2);
  });

  it("treats an omitted shown-count as the total", () => {
    const parsed = parseCatalog("# Code Mode\n\n- full (7 tools)\n  - tools.full.a({\n}) // x\n")!;
    expect(parsed.namespaces[0]?.listed).toBe(7);
  });
});

describe("parseCatalog against real captured traffic", () => {
  it.skipIf(REAL === null)("parses real traffic into namespaces with tools", () => {
    const parsed = parseCatalog(REAL!)!;
    expect(parsed.namespaces.length).toBeGreaterThan(0);
    for (const namespace of parsed.namespaces) {
      expect(namespace.name).toBeTruthy();
      expect(namespace.total).toBeGreaterThan(0);
      // A namespace with no listed tool would silently drop its cost.
      expect(namespace.tools.length).toBeGreaterThan(0);
      for (const tool of namespace.tools) {
        expect(tool.path).toMatch(/^tools\./);
        expect(tool.text.length).toBeGreaterThan(0);
      }
    }
  });

  it.skipIf(REAL === null)("assigns every real tool to a namespace", () => {
    const parsed = parseCatalog(REAL!)!;
    const all = parsed.namespaces.flatMap((n) => n.tools);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((tool) => tool.namespace.length > 0)).toBe(true);
  });
});
