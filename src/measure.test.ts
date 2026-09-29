import { beforeEach, describe, expect, it } from "vitest";
import {
  CATEGORIES,
  emptyCategories,
  estimateTokens,
  measure,
  readSystemPart,
  reconcile,
  resetTokenizerCache,
  resolveTokenizer,
  type Tokenizer,
} from "./measure.ts";

/**
 * Fixtures reproduce the structure a live OpenCode 2.0.18 session produced,
 * because the segmentation rules are written against that shape and would
 * silently pass against anything hand-written to match the code.
 */
const HARNESS = `You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.

# Harness
- Responses are rendered as GitHub-flavored Markdown.
- Prefer parallelizing independent tool calls.`;

const CODE_MODE = `# Code Mode

Use the \`execute\` tool to call the tools listed below. They cannot be called directly, and neither can \`search\`.

The catalog is partial. Inside \`execute\`, use \`search(...)\` to find a tool, then call it by the \`path\` in the result.`;

const SKILLS_BLOCK = `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns.
<available_skills>
  <skill>
    <id>mytest</id>
    <name>mytest</name>
    <description>A test skill for measuring context cost</description>
  </skill>
  <skill>
    <id>graphify</id>
    <name>graphify</name>
    <description>Use for any question about a codebase, its architecture, file relationships, or project content.</description>
  </skill>
</available_skills>`;

const MEMORY_BLOCK = `Instructions from: /tmp/oc-test/AGENTS.md
# Project memory

Always use tabs. Never use spaces. This is a memory file with some content to measure.`;

const ENV_BLOCK = `Today's date: Tue Sep 29 2026

Here is some useful information about the environment you are running in:
<env>
  Working directory: /tmp/oc-test
  Workspace root folder: /tmp/oc-test
  Is directory a git repo: no
  Platform: linux
</env>`;

const MCP_BLOCK = `<mcp_instructions>
<server name="chrome-devtools">
Tools from this server are available via \`tools["chrome-devtools"]\`.

## close_page
Closes the page with the given pageId.
</server>
<server name="open-design">
Tools from this server are available via \`tools["open-design"]\`.
</server>
</mcp_instructions>`;

/** The composite part a real session produced: several sources in one payload. */
const COMPOSITE = [CODE_MODE, SKILLS_BLOCK, MEMORY_BLOCK, ENV_BLOCK].join("\n\n");

/**
 * A tokenizer that is exactly predictable, so tests can assert on counts rather
 * than on whatever a real BPE decides.
 */
const countingTokenizer: Tokenizer = {
  name: "test",
  exact: true,
  async count(text) {
    // One "token" per non-empty line, which makes attribution assertions exact.
    return text.split("\n").filter((line) => line.trim() !== "").length;
  },
};

const base = () => ({ system: [] as { text: string }[], tools: {}, messages: [] as { role: string; text: string }[] });

describe("estimateTokens", () => {
  it("returns zero for empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("charges punctuation more than an equal run of words", () => {
    // The point of the split: a JSON schema must not be measured as prose. Both
    // strings are 25 characters holding the same number of letters, colons and
    // digits, so only the word/symbol ratio separates them.
    const schema = '{"a":1,"b":2,"c":3,"d":4}';
    const glued = "aa:aa:aa:aa:aa:aa:aa:aa:a";
    expect(schema.length).toBe(glued.length);
    expect(estimateTokens(schema)).toBeGreaterThan(estimateTokens(glued));
  });

  it("ignores whitespace", () => {
    expect(estimateTokens("a b c")).toBe(estimateTokens("a\nb\tc  "));
  });
});

describe("resolveTokenizer", () => {
  beforeEach(() => {
    resetTokenizerCache();
  });

  it("resolves a real tokenizer for a known model family", async () => {
    const tokenizer = await resolveTokenizer("anthropic", "claude-sonnet-5");
    expect(tokenizer).toBeDefined();
    expect(typeof (await tokenizer!.count("hello world"))).toBe("number");
  });

  it("counts with a real BPE rather than the heuristic", async () => {
    const tokenizer = await resolveTokenizer("openai", "gpt-4o");
    // cl100k_base gives exactly 2 for this; the word/symbol heuristic would
    // give 4, so this distinguishes the two paths.
    expect(await tokenizer!.count("hello world")).toBe(2);
  });

  it("falls back to a general BPE for a model family it does not know", async () => {
    // Unrecognised ids are released constantly behind provider-specific names.
    // Dropping to a character heuristic for all of them would be a large
    // accuracy loss, so a general BPE stands in — and says so.
    const tokenizer = await resolveTokenizer("some-provider", "some-unreleased-model");
    expect(tokenizer).toBeDefined();
    expect(tokenizer?.exact).toBe(false);
    expect(tokenizer?.name).toContain("approximate");
  });

  it("marks a recognised family's tokenizer as exact", async () => {
    expect((await resolveTokenizer("anthropic", "claude-sonnet-5"))?.exact).toBe(true);
  });

  it("caches the resolved tokenizer per family", async () => {
    const first = resolveTokenizer("openai", "gpt-4o");
    const second = resolveTokenizer("openai", "gpt-4o");
    expect(await first).toBe(await second);
  });
});

describe("readSystemPart", () => {
  it("returns the lines and spans a caller can count", () => {
    const read = readSystemPart(HARNESS);
    expect(read.lines.length).toBeGreaterThan(0);
    // A single section covering the whole part when nothing is recognised.
    expect(read.sectionSpans).toHaveLength(1);
    expect(read.sectionSpans[0]?.category).toBe("system");
  });

  it("separates the sources inside one composite part", () => {
    const read = readSystemPart(COMPOSITE);
    const kinds = new Set(read.sectionSpans.map((span) => span.category));
    expect(kinds).toContain("tools");
    expect(kinds).toContain("skills");
    expect(kinds).toContain("memory");
    expect(kinds).toContain("environment");
  });

  it("recognises an MCP instructions block as its own section", () => {
    const read = readSystemPart(`${HARNESS}\n\n${MCP_BLOCK}`);
    expect(read.sectionSpans.some((span) => span.category === "mcp")).toBe(true);
  });

  it("gives each memory file its exact line range", () => {
    const read = readSystemPart(COMPOSITE);
    const file = read.memoryFiles[0];
    expect(file?.path).toBe("/tmp/oc-test/AGENTS.md");
    // The range must actually cover the heading and the body it announced.
    expect(read.lines[file!.start]).toBe("Instructions from: /tmp/oc-test/AGENTS.md");
    expect(file!.end).toBeGreaterThan(file!.start);
  });

  it("keeps two memory files in one part separate", () => {
    const two = "Instructions from: /a/AGENTS.md\nfirst body\n\nInstructions from: /b/CLAUDE.md\nsecond body";
    const read = readSystemPart(two);
    expect(read.memoryFiles.map((f) => f.path)).toEqual(["/a/AGENTS.md", "/b/CLAUDE.md"]);
  });

  it("carries each skill's verbatim text for counting", () => {
    const read = readSystemPart(SKILLS_BLOCK);
    expect(read.skills.map((s) => s.id)).toEqual(["mytest", "graphify"]);
    // The text is what the provider tokenizes, so it must include the fields.
    expect(read.skills[0]?.text).toContain("<description>");
  });

  it("still reports an unterminated catalogue rather than dropping it", () => {
    const truncated = `<available_skills>\n  <skill>\n    <id>x</id>\n    <name>x</name>\n    <description>d</description>\n  </skill>`;
    expect(readSystemPart(truncated).skills.map((s) => s.id)).toEqual(["x"]);
  });

  it("returns empty spans for empty input", () => {
    const read = readSystemPart("");
    expect(read.lines).toEqual([""]);
    expect(read.memoryFiles).toEqual([]);
    expect(read.skills).toEqual([]);
  });
});

describe("measure", () => {
  const schema = { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } }, required: ["path"] };

  it("attributes each source to its own category", async () => {
    const result = await measure({ ...base(), system: [{ text: COMPOSITE }] });
    expect(result.categories.tools).toBeGreaterThan(0);
    expect(result.categories.skills).toBeGreaterThan(0);
    expect(result.categories.memory).toBeGreaterThan(0);
    expect(result.categories.environment).toBeGreaterThan(0);
  });

  it("marks the measurement as tokenized only when a tokenizer was supplied", async () => {
    const withoutToken = await measure({ ...base(), system: [{ text: HARNESS }] });
    expect(withoutToken.tokenized).toBe(false);

    const withToken = await measure({ ...base(), system: [{ text: HARNESS }], tokenizer: countingTokenizer });
    expect(withToken.tokenized).toBe(true);
  });

  it("splits tools into builtin and MCP buckets", async () => {
    const result = await measure({
      ...base(),
      tools: {
        read: { description: "Read a file.", input: schema },
        "browser_tabs_open": { description: "Open a tab.", input: schema },
      },
      mcpTools: { browser_tabs_open: "browser" },
    });
    expect(result.categories.mcp).toBeGreaterThan(0);
    expect(result.categories.tools).toBeGreaterThan(0);
    const mcpTool = result.tools.find((tool) => tool.name === "browser_tabs_open");
    expect(mcpTool?.mcp).toBe(true);
    expect(mcpTool?.server).toBe("browser");
  });

  it("keeps measuredTotal equal to the sum of its categories", async () => {
    const result = await measure({
      ...base(),
      system: [{ text: HARNESS }, { text: COMPOSITE }],
      tools: { read: { description: "Read a file.", input: schema } },
      messages: [{ role: "user", text: "hello" }],
    });
    const sum = CATEGORIES.reduce((acc, key) => acc + result.categories[key], 0);
    expect(result.measuredTotal).toBe(sum);
  });

  it("does not double-count across parts", async () => {
    const split = await measure({ ...base(), system: [{ text: HARNESS }, { text: COMPOSITE }] });
    const whole = await measure({ ...base(), system: [{ text: `${HARNESS}\n\n${COMPOSITE}` }] });
    expect(split.measuredTotal).toBe(whole.measuredTotal);
  });

  it("keeps the detail lists within the totals they sit under", async () => {
    const result = await measure({ ...base(), system: [{ text: COMPOSITE }] });
    const skills = result.skills.reduce((sum, entry) => sum + entry.tokens, 0);
    const files = result.memoryFiles.reduce((sum, entry) => sum + entry.tokens, 0);
    expect(skills).toBeLessThanOrEqual(result.categories.skills);
    expect(files).toBeLessThanOrEqual(result.categories.memory);
  });

  it("sorts detail lists largest first", async () => {
    const result = await measure({
      ...base(),
      tools: {
        small: { description: "tiny", input: {} },
        large: { description: "a considerably longer description of what this tool does", input: schema },
      },
    });
    expect(result.tools[0]?.name).toBe("large");
  });

  it("tolerates missing sections", async () => {
    const result = await measure({ system: undefined as never, tools: undefined as never, messages: undefined as never });
    expect(result.measuredTotal).toBe(0);
  });
});

describe("reconcile", () => {
  const baseMeasured = () => measure({ ...base(), system: [{ text: HARNESS }], messages: [{ role: "user", text: "hello there" }] });

  it("scales estimated parts to sum to the provider's reading", async () => {
    const before = await baseMeasured();
    const after = reconcile(before, before.measuredTotal * 2);
    const sum = CATEGORIES.reduce((acc, key) => acc + after.categories[key], 0);
    expect(sum).toBe(before.measuredTotal * 2);
  });

  it("keeps the relative proportions of the parts", async () => {
    const before = await baseMeasured();
    const after = reconcile(before, before.measuredTotal * 2);
    for (const key of CATEGORIES) {
      if (before.categories[key] === 0) continue;
      expect(after.categories[key] / after.measuredTotal).toBeCloseTo(
        before.categories[key] / before.measuredTotal,
        1,
      );
    }
  });

  it("adopts the provider's total for the headline but leaves measured parts alone", async () => {
    // With a real tokenizer the parts are measurements, and bending them to
    // match the provider's total would misrepresent what was counted. The
    // headline still becomes the provider's number, because that is the number
    // the model is actually charged for; the residual is framing overhead the
    // tokenizer never saw.
    const before = await measure({ ...base(), system: [{ text: HARNESS }], tokenizer: countingTokenizer });
    const after = reconcile(before, before.measuredTotal * 2);
    expect(after.measuredTotal).toBe(before.measuredTotal * 2);
    expect(after.categories).toEqual(before.categories);
  });

  it("leaves the measurement alone when there is no reading", async () => {
    const before = await baseMeasured();
    expect(reconcile(before, undefined).measuredTotal).toBe(before.measuredTotal);
    expect(reconcile(before, 0).measuredTotal).toBe(before.measuredTotal);
  });

  it("refuses to scale when the two numbers describe different moments", async () => {
    const before = await baseMeasured();
    expect(reconcile(before, before.measuredTotal * 10).measuredTotal).toBe(before.measuredTotal);
  });

  it("does not mutate its input", async () => {
    const before = await baseMeasured();
    const snapshot = JSON.stringify(before);
    reconcile(before, before.measuredTotal * 2);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("emptyCategories", () => {
  it("covers every category with a zero", () => {
    const empty = emptyCategories();
    for (const key of CATEGORIES) expect(empty[key]).toBe(0);
  });
});

describe("request framing", () => {
  it("reports the difference between the whole body and the parts", async () => {
    const input = { ...base(), system: [{ text: HARNESS }] };
    const parts = await measure({ ...input, tokenizer: countingTokenizer });
    const whole = await measure({ ...input, tokenizer: countingTokenizer, envelope: parts.measuredTotal + 500 });
    // The categories measure content; the envelope also carries JSON scaffolding
    // the provider counts. That remainder must be reported, not absorbed.
    expect(whole.unattributed).toBe(500);
  });

  it("reports nothing when the parts already cover the whole body", async () => {
    const input = { ...input0(), system: [{ text: HARNESS }] };
    const parts = await measure({ ...input, tokenizer: countingTokenizer });
    const whole = await measure({ ...input, tokenizer: countingTokenizer, envelope: parts.measuredTotal });
    expect(whole.unattributed).toBe(0);
  });

  it("never reports a negative remainder when the parts exceed the body", async () => {
    const input = { ...input0(), system: [{ text: HARNESS }] };
    const parts = await measure({ ...input, tokenizer: countingTokenizer });
    const whole = await measure({ ...input, tokenizer: countingTokenizer, envelope: Math.round(parts.measuredTotal / 2) });
    expect(whole.unattributed).toBe(0);
  });

  it("reports no framing without a tokenizer", async () => {
    const input = { ...input0(), system: [{ text: HARNESS }] };
    const estimated = await measure({ ...input, envelope: 99_999 });
    // An estimate of the body and an estimate of its parts would differ for
    // reasons that mean nothing, so nothing is claimed.
    expect(estimated.unattributed).toBe(0);
  });

  it("reports no framing when no envelope was supplied", async () => {
    const result = await measure({ ...input0(), system: [{ text: HARNESS }], tokenizer: countingTokenizer });
    expect(result.unattributed).toBe(0);
  });
});

function input0() {
  return { system: [] as { text: string }[], tools: {}, messages: [] as { role: string; text: string }[] };
}

/**
 * With Code Mode on, MCP tools are described in the system prompt's catalogue
 * rather than as request-body definitions. These pin that path, because the
 * symptom when it is broken is an MCP bucket that simply stays at zero.
 */
const CATALOGUE = `# Code Mode

Use the \`execute\` tool to call the tools listed below.

## Available tools

- chrome-devtools (30 tools, 2 shown) // Desktop browser tools.
  - tools["chrome-devtools"].close_page({
  /**
   * The page to close.
   */
  pageId: number,
}): Promise<unknown> // Closes the page.
  - tools["chrome-devtools"].list_pages({
}): Promise<unknown> // List pages.

- open-design (22 tools, 1 shown) // Local-first design workspace.
  - tools["open-design"].cancel_run({
  /** Run id. */
  runId: string,
}): Promise<unknown> // Cancel a run.

- browser (45 tools, 1 shown) // Desktop browser tools.
  - tools.browser.tabs.list({
}): Promise<unknown> // List tabs.
`;

describe("MCP attribution through the Code Mode catalogue", () => {

  it("charges MCP namespaces to the MCP bucket, not to tools", async () => {
    const result = await measure({
      ...base(),
      system: [{ text: CATALOGUE }],
      mcpNamespaces: ["chrome-devtools", "open-design"],
      tokenizer: countingTokenizer,
    });
    expect(result.categories.mcp).toBeGreaterThan(0);
    // The MCP cost must have left the builtin bucket rather than sitting in
    // both, which is what a naive split would do.
    expect(result.categories.mcp).toBeLessThan(result.categories.tools + result.categories.mcp);
  });

  it("labels every MCP tool with the server that provided it", async () => {
    const result = await measure({
      ...base(),
      system: [{ text: CATALOGUE }],
      mcpNamespaces: ["chrome-devtools", "open-design"],
      tokenizer: countingTokenizer,
    });
    const mcpTools = result.tools.filter((tool) => tool.mcp);
    expect(mcpTools.length).toBeGreaterThan(0);
    // Each MCP server contributes, and nothing is attributed to a third party.
    expect([...new Set(mcpTools.map((tool) => tool.server))].sort()).toEqual(["chrome-devtools", "open-design"]);
    // Its individual tools are named, not just the namespace.
    expect(mcpTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["close_page", "list_pages", "cancel_run"]),
    );
    // The non-MCP namespace stays a builtin tool.
    expect(result.tools.filter((tool) => !tool.mcp).map((tool) => tool.name)).toContain("list");
  });

  it("charges a namespace's header to the namespace", async () => {
    const result = await measure({
      ...base(),
      system: [{ text: CATALOGUE }],
      mcpNamespaces: ["chrome-devtools"],
      tokenizer: countingTokenizer,
    });
    // Headers are prompt content; without this a namespace's own line is free.
    expect(result.tools.some((tool) => tool.name.includes("(namespace)"))).toBe(true);
  });

  it("leaves every namespace in the builtin bucket when none is an MCP server", async () => {
    const result = await measure({
      ...base(),
      system: [{ text: CATALOGUE }],
      mcpNamespaces: [],
      tokenizer: countingTokenizer,
    });
    expect(result.categories.mcp).toBe(0);
    expect(result.categories.tools).toBeGreaterThan(0);
  });

  it("moves the catalogue's cost between buckets without creating any", async () => {
    // Splitting the catalogue by namespace re-attributes the same text, so the
    // total must not move. It would roughly double if the catalogue were both
    // counted here and again as the surrounding `tools` section.
    const withCatalog = await measure({
      ...base(),
      system: [{ text: CATALOGUE }],
      mcpNamespaces: ["chrome-devtools", "open-design"],
      tokenizer: countingTokenizer,
    });
    const withoutCatalog = await measure({ ...base(), system: [{ text: CATALOGUE }], tokenizer: countingTokenizer });
    expect(withCatalog.measuredTotal).toBe(withoutCatalog.measuredTotal);
    // The split itself did move cost out of the builtin bucket.
    expect(withCatalog.categories.tools).toBeLessThan(withoutCatalog.categories.tools);
    expect(withCatalog.categories.mcp).toBeGreaterThan(0);
  });
});

/**
 * A catalogue namespace is in the prompt, so it is MCP whatever the connection
 * happened to be doing when the request was made.
 *
 * The instructions block is not a complete list — in a real prompt only some
 * servers document themselves — but a server that does declare itself is
 * authoritative, and using it means a capture taken during a reconnect still
 * attributes its cost instead of filing the whole description under builtins.
 */
const PROMPT_WITH_SERVERS = `${CATALOGUE}
<mcp_instructions>
  <server name="open-design">
    Use tools from this server through \`execute\`.
  </server>
</mcp_instructions>
`;

describe("MCP attribution from the prompt's own server list", () => {
  it("attributes a self-declared server even when the live list is empty", async () => {
    const fromPrompt = await measure({
      ...base(),
      system: [{ text: PROMPT_WITH_SERVERS }],
      // Nothing connected: this is the state that used to hide the whole
      // namespace behind the builtin bucket.
      mcpNamespaces: [],
      tokenizer: countingTokenizer,
    });
    const mcp = fromPrompt.tools.filter((tool) => tool.mcp);
    expect(mcp.length).toBeGreaterThan(0);
    expect([...new Set(mcp.map((tool) => tool.server))]).toEqual(["open-design"]);

    // Same text, but this time the server is named by the live list. Declaring
    // it in the prompt has to reach the same answer, and reach it by moving
    // cost out of the builtin bucket rather than by counting the same text
    // twice.
    const fromLiveList = await measure({
      ...base(),
      system: [{ text: PROMPT_WITH_SERVERS }],
      mcpNamespaces: ["open-design"],
      tokenizer: countingTokenizer,
    });
    expect(fromPrompt.categories.mcp).toBe(fromLiveList.categories.mcp);
    expect(fromPrompt.categories.tools).toBe(fromLiveList.categories.tools);
    expect(fromPrompt.measuredTotal).toBe(fromLiveList.measuredTotal);

    const undeclared = await measure({
      ...base(),
      system: [{ text: CATALOGUE }],
      mcpNamespaces: [],
      tokenizer: countingTokenizer,
    });
    expect(undeclared.categories.mcp).toBe(0);
  });

  it("leaves a namespace the prompt does not declare as a builtin", async () => {
    // `chrome-devtools` and `browser` are in the catalogue but declare nothing,
    // so they stay builtin until the live list names them.
    const result = await measure({
      ...base(),
      system: [{ text: PROMPT_WITH_SERVERS }],
      mcpNamespaces: [],
      tokenizer: countingTokenizer,
    });
    expect(result.tools.filter((tool) => !tool.mcp).map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["close_page", "list_pages", "list"]),
    );
  });

  it("reads the declared names", () => {
    const read = readSystemPart(PROMPT_WITH_SERVERS);
    expect(read.mcpServers).toEqual(["open-design"]);
  });

  it("ignores a server entry that sits outside the instructions block", () => {
    // The extraction is bounded by the block, so a stray match in a tool
    // description cannot invent a connector.
    const read = readSystemPart(`<available_skills>\nuse <server name="not-a-server">\n</available_skills>`);
    expect(read.mcpServers).toEqual([]);
  });
});

/**
 * The catalogue sits inside the system prompt's tool section, and the sections
 * that follow it — skills, memory files, the environment block — are counted in
 * their own categories. A catalogue that runs past its section claims those
 * too, and every one of them is then counted twice.
 */
describe("catalogue does not absorb the sections after it", () => {
  it("leaves the trailing sections in their own categories", async () => {
    const result = await measure({ ...base(), system: [{ text: CATALOGUE_SECTIONS }], tokenizer: countingTokenizer });
    // These are counted from their own spans, once.
    expect(result.categories.skills).toBeGreaterThan(0);
    expect(result.categories.memory).toBeGreaterThan(0);
    expect(result.categories.environment).toBeGreaterThan(0);
    // The sum of every category is the measured total, and the per-category
    // figures do not add up to more than the whole.
    const sum = CATEGORIES.reduce((acc, key) => acc + result.categories[key], 0);
    expect(sum).toBe(result.measuredTotal);
  });

  it("attributes the trailing sections the same with or without a catalogue", async () => {
    // The same trailing text, once with a tool catalogue in front of it and
    // once without. A catalogue that swallowed its tail would inflate the
    // skills, memory and environment figures, so they must come out identical.
    const withCatalog = await measure({ ...base(), system: [{ text: CATALOGUE_SECTIONS }], tokenizer: countingTokenizer });
    const withoutCatalog = await measure({
      ...base(),
      system: [{ text: CATALOGUE_SECTIONS.split("Skills provide")[1] ? "Skills provide" + CATALOGUE_SECTIONS.split("Skills provide")[1]! : "" }],
      tokenizer: countingTokenizer,
    });
    expect(withoutCatalog.categories.skills).toBe(withCatalog.categories.skills);
    expect(withoutCatalog.categories.memory).toBe(withCatalog.categories.memory);
    expect(withoutCatalog.categories.environment).toBe(withCatalog.categories.environment);
    // Only the tool bucket differs, by the catalogue's own size.
    expect(withCatalog.categories.tools).toBeGreaterThan(withoutCatalog.categories.tools);
  });
});

/** A catalogue followed, in the same part, by the other prompt sections. */
const CATALOGUE_SECTIONS = `# Code Mode

Use the \`execute\` tool to call the tools listed below.

## Available tools

- chrome-devtools (30 tools, 2 shown) // Desktop browser tools.
  - tools["chrome-devtools"].close_page({
  pageId: number,
}): Promise<unknown> // Closes the page.

- browser (45 tools, 1 shown) // Desktop browser tools.
  - tools.browser.tabs.list({
}): Promise<unknown> // List tabs.

Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <id>alpha</id>
    <name>alpha</name>
    <description>The first skill.</description>
  </skill>
</available_skills>

Instructions from: /p/AGENTS.md
# Project memory

Always use tabs.

Today's date: Tue Sep 29 2026

Here is some useful information about the environment you are running in:
<env>
  Working directory: /p
</env>
`;
