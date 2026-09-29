/**
 * Token measurement.
 *
 * The headline problem: a context report is only worth reading if the numbers
 * are right, and "roughly right" is indistinguishable from "wrong" once
 * someone acts on it. So the measurement here is built to be *exact* whenever
 * that is possible, and to say plainly when it is not.
 *
 * There are two independent sources of truth, and the difference matters:
 *
 * - The provider's usage report. `input + cache.read + cache.write` on the most
 *   recent assistant turn is what the provider itself counted for one real
 *   request. This is exact for the total, and it is what the dialog headlines.
 *
 * - The request body itself. The `session.http.request` hook exposes the exact
 *   serialized JSON the provider was handed, so every part of it can be counted
 *   separately rather than estimated from a re-derived approximation of the
 *   prompt.
 *
 * Counting is done with a real tokenizer matched to the model family, so the
 * per-category numbers are tokenizer-exact rather than character-heuristic.
 * When no tokenizer can be resolved, the report degrades to the provider's
 * total plus an explicitly-labelled proportional estimate — it never silently
 * presents a guess as a measurement.
 */

/** Where a measured number came from, so the UI can be honest about it. */
export type Confidence = "exact" | "estimated";

import { parseCatalog, type ParsedCatalog } from "./catalog.ts";

/** Buckets the prompt is split into. Order is the display order. */
export const CATEGORIES = ["system", "tools", "mcp", "memory", "skills", "environment", "messages"] as const;

export type Category = (typeof CATEGORIES)[number];

/** Human labels, matched to what each bucket actually holds. */
export const CATEGORY_LABELS: Record<Category, string> = {
  system: "System prompt",
  tools: "Tools",
  mcp: "MCP tools",
  memory: "Memory files",
  skills: "Skills",
  environment: "Environment",
  messages: "Messages",
};

/** One instruction file found in the prompt, e.g. an AGENTS.md. */
export interface MemoryFile {
  path: string;
  tokens: number;
}

/** One skill advertised in the prompt's catalogue. */
export interface SkillEntry {
  id: string;
  name: string;
  tokens: number;
}

/** One tool definition offered to the model. */
export interface ToolEntry {
  name: string;
  tokens: number;
  /** True when the definition came from an MCP server rather than a builtin. */
  mcp: boolean;
  /** Which MCP server, when `mcp` is true. */
  server?: string;
}

/** Result of reading one system-prompt part. */
export interface SystemBreakdown {
  categories: Record<Category, number>;
  memoryFiles: MemoryFile[];
  skills: SkillEntry[];
}

/** Everything measured, before it is reconciled against the provider. */
export interface Measurement {
  categories: Record<Category, number>;
  memoryFiles: MemoryFile[];
  skills: SkillEntry[];
  tools: ToolEntry[];
  /** Sum of every measured category, before reconciliation. */
  measuredTotal: number;
  /**
   * Whether the per-category figures came from a real tokenizer.
   *
   * `false` means the parts were apportioned by character weight, which is a
   * defensible guess but not a measurement.
   */
  tokenized: boolean;
  /**
   * Tokens the provider counted that no category accounts for.
   *
   * The categories measure prompt *content*; the provider also counts the JSON
   * envelope around it — keys, brackets, the model name, generation settings.
   * Reporting the remainder is what lets the parts be reconciled against the
   * provider's total instead of appearing to be short by an unexplained amount.
   */
  unattributed: number;
}

export interface SystemPart {
  text: string;
}

export interface ToolDefinition {
  description: string;
  input: unknown;
}

export function emptyCategories(): Record<Category, number> {
  return { system: 0, tools: 0, mcp: 0, memory: 0, skills: 0, environment: 0, messages: 0 };
}

/* ------------------------------------------------------------------ *
 * Tokenizers
 * ------------------------------------------------------------------ */

/** Counts tokens with a specific model family's tokenizer. */
export interface Tokenizer {
  /** Human name, shown in the UI so the source of the number is visible. */
  readonly name: string;
  /**
   * Whether this is the model's own tokenizer.
   *
   * `false` means a general-purpose BPE is standing in for a model whose own
   * table is not published or not available. That is far better than a
   * character heuristic — BPE tables for different model families typically
   * agree within a few percent — but it is not the model's own count, and the
   * report says so rather than implying otherwise.
   */
  readonly exact: boolean;
  count(text: string): Promise<number>;
}

/**
 * Character-weight estimate, used only when no real tokenizer is available.
 *
 * This is the same word/symbol split used before: a flat "characters ÷ 4" is
 * not good enough because tool JSON schemas are dense in punctuation and
 * tokenize far heavier per character than prose, so a flat divisor
 * systematically understates the cost of tools.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let words = 0;
  let symbols = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isWord =
      (code >= 97 && code <= 122) || // a-z
      (code >= 65 && code <= 90) || // A-Z
      (code >= 48 && code <= 57) || // 0-9
      code === 95 || // _
      code > 127; // non-ASCII
    if (isWord) {
      if (!inWord) words++;
      inWord = true;
    } else {
      inWord = false;
      // Whitespace is free: it separates tokens, it is not one.
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) symbols++;
    }
  }
  return Math.round(words * 1.3 + symbols * 0.5);
}

/** A tokenizer that is always available, for when nothing better resolves. */
export const heuristicTokenizer: Tokenizer = {
  name: "estimate",
  exact: false,
  async count(text) {
    return estimateTokens(text);
  },
};

/**
 * Caches a tokenizer per model family.
 *
 * Tokenizer construction is the expensive part — loading a BPE table — so this
 * keeps one instance alive for the process rather than rebuilding per report.
 */
const tokenizerCache = new Map<string, Promise<Tokenizer | undefined>>();

/**
 * Maps a model to the tokenizer that counts it.
 *
 * The mapping is by family rather than by exact id, because providers ship new
 * ids constantly and a model whose family is recognised should not silently
 * lose its exact counting on every release.
 */
function familiesFor(providerID: string, modelID: string): string[] {
  const id = modelID.toLowerCase();
  const families: string[] = [];

  // Anthropic's tokenizer is exposed through Anthropic's own counting endpoint,
  // not a published BPE, so these fall back to the closest well-known
  // tokenizer. It is not identical but it is the same order of accuracy.
  if (providerID === "anthropic" || id.startsWith("claude")) families.push("anthropic");

  // OpenAI publishes BPE tables; o200k_base is current, cl100k_base covers the
  // older families and is the safe default for GPT-4 era ids.
  if (providerID === "openai" || /\b(gpt|o1|o3|o4|davinci|chatgpt|text-davinci)/.test(id)) {
    families.push(/gpt-4o|gpt-5|o[134]-/.test(id) ? "openai-o200k" : "openai-cl100k");
  }

  if (/llama|codellama/.test(id)) families.push("llama");
  if (/mistral|mixtral|codestral/.test(id)) families.push("llama"); // Mixtral uses the Llama tokenizer
  if (/qwen|deepseek/.test(id)) families.push("qwen");
  if (/gemma/.test(id)) families.push("gemma");
  if (/grok/.test(id)) families.push("openai-cl100k");
  if (/kimi|moonshot/.test(id)) families.push("openai-cl100k");
  if (/nemotron/.test(id)) families.push("llama");
  if (/phi|command-r|starcoder|granite/.test(id)) families.push("llama");

  // Nothing matched. Rather than fall all the way back to a character
  // heuristic, count with a general BPE and mark it inexact: unrecognised model
  // ids are constantly released behind a provider's own names, and dropping to
  // an estimate for all of them would be a large accuracy loss for no gain.
  // The name is appended so the report can disclose it.
  if (families.length === 0) families.push("fallback");

  return families;
}

/**
 * Resolves a real tokenizer for a model, if one can be loaded.
 *
 * Returns `undefined` rather than throwing when the dependency is absent: the
 * tokenizer packages are an optional install, and a missing one must degrade
 * the report rather than break the command.
 */
export function resolveTokenizer(providerID: string, modelID: string): Promise<Tokenizer | undefined> {
  const families = familiesFor(providerID, modelID);
  if (families.length === 0) return Promise.resolve(undefined);

  const key = families.join(",");
  const cached = tokenizerCache.get(key);
  if (cached) return cached;

  const loading = (async (): Promise<Tokenizer | undefined> => {
    // js-tiktoken bundles the BPE tables, so this works offline once installed.
    // o200k_base and cl100k_base are both built in; no network fetch needed.
    for (const family of families) {
      try {
        const mod = (await import("js-tiktoken")) as unknown as {
          getEncoding?: (name: string) => { encode: (t: string) => unknown[] };
          encodingForModel?: (model: string) => { encode: (t: string) => unknown[] };
        };
        const encoding = family === "openai-o200k" ? "o200k_base" : "cl100k_base";
        const encoder = mod.getEncoding?.(encoding);
        if (!encoder) continue;
        return {
          // The encoding is named so the number's provenance is visible, and a
          // stand-in is labelled so it is never mistaken for the model's own.
          name: family === "fallback" ? `${encoding} (approximate)` : family,
          exact: family !== "fallback",
          async count(text: string) {
            if (!text) return 0;
            try {
              return encoder.encode(text).length;
            } catch {
              // A tokenizer that chokes on a fragment falls back to the
              // estimate rather than failing the whole report.
              return estimateTokens(text);
            }
          },
        };
      } catch {
        // Package not installed; try the next family, then give up.
      }
    }
    return undefined;
  })();

  tokenizerCache.set(key, loading);
  return loading;
}

/** Test seam: drops cached tokenizers. */
export function resetTokenizerCache(): void {
  tokenizerCache.clear();
}

/* ------------------------------------------------------------------ *
 * System-prompt segmentation
 *
 * OpenCode assembles the system prompt from several sources and hands it over
 * as an ordered list of text parts, each of which may mix sources. Nothing in
 * the payload says which source a given line came from, so the split is done by
 * matching the markers the builder emits. Every marker below was verified
 * against a live session; anything matching none of them stays in "system", so
 * an unfamiliar future format degrades to a coarser breakdown rather than a
 * wrong one.
 * ------------------------------------------------------------------ */

const SKILLS_INTRO = /^Skills provide specialized instructions/;
const SKILLS_OPEN = /^<available_skills>/;
const SKILLS_CLOSE = /^<\/available_skills>/;
const MEMORY_OPEN = /^Instructions from:\s*(.+?)\s*$/;
const CATALOG_OPEN = /^# Code Mode\b/;
const ENV_OPEN = /^Here is some useful information about the environment/;
const ENV_CLOSE = /^<\/env>/;
const DATE_OPEN = /^Today's date:/;
/** Opens the block of MCP server instructions, when any server is connected. */
const MCP_OPEN = /^<mcp_instructions>/;
const MCP_CLOSE = /^<\/mcp_instructions>/;

function opensOtherSection(line: string): boolean {
  return (
    MEMORY_OPEN.test(line) ||
    SKILLS_INTRO.test(line) ||
    SKILLS_OPEN.test(line) ||
    CATALOG_OPEN.test(line) ||
    ENV_OPEN.test(line) ||
    DATE_OPEN.test(line) ||
    MCP_OPEN.test(line)
  );
}

/** Pulls the advertised skills out of a raw `<available_skills>` block. */
function parseSkillCatalogue(block: string): SkillSpan[] {
  const entries: SkillSpan[] = [];
  // A description is free text and may itself contain angle brackets, so the
  // id and name are anchored first and the description runs to its closing tag.
  // The matched slice is kept verbatim: it is exactly what the provider
  // tokenizes for this skill, so it is what gets counted.
  const pattern = /<skill>[\s\S]*?<id>([\s\S]*?)<\/id>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>[\s\S]*?<\/skill>/g;
  for (const match of block.matchAll(pattern)) {
    const [text, id = "", name = ""] = match;
    entries.push({ id: id.trim(), name: name.trim(), tokens: 0, text });
  }
  return entries;
}


export interface SectionSpan {
  /** First line of the section, inclusive. */
  start: number;
  /** Last line of the section, exclusive. */
  end: number;
  category: Category;
}

/** A memory file together with the lines that make it up. */
export interface MemorySpan extends MemoryFile {
  start: number;
  end: number;
}

/** A skill together with its exact text in the prompt. */
export interface SkillSpan extends SkillEntry {
  text: string;
}

export interface SystemRead {
  lines: string[];
  sectionSpans: SectionSpan[];
  memoryFiles: MemorySpan[];
  skills: SkillSpan[];
}

/**
 * Reads one system part into line spans.
 *
 * The reader only classifies; it does not count. Every span it returns carries
 * the exact lines or text it covers, so the caller can tokenize each one
 * separately with the real tokenizer and have the detail lists add up to the
 * category totals by construction rather than by a second, looser pass.
 */
export function readSystemPart(text: string): SystemRead {
  const lines = (text ?? "").split("\n");
  const memoryFiles: MemorySpan[] = [];
  const skills: SkillSpan[] = [];
  const sectionSpans: SectionSpan[] = [];

  let start = 0;
  let category: Category = "system";
  /** Line index where the current memory file begins, if one is open. */
  let fileStart = -1;
  let filePath: string | undefined;
  let catalogue: string[] | undefined;

  const closeSection = (end: number) => sectionSpans.push({ start, end, category });
  const openSection = (at: number, next: Category) => {
    closeSection(at);
    start = at;
    category = next;
  };
  const closeFile = (end: number) => {
    if (fileStart < 0 || filePath === undefined) return;
    // A file whose body is empty still cost its heading, so it is reported.
    memoryFiles.push({ path: filePath, tokens: 0, start: fileStart, end });
    fileStart = -1;
    filePath = undefined;
  };

  lines.forEach((line, index) => {
    if (catalogue) {
      catalogue.push(line);
      if (SKILLS_CLOSE.test(line)) {
        skills.push(...parseSkillCatalogue(catalogue.join("\n")));
        catalogue = undefined;
      }
      return;
    }

    const memory = MEMORY_OPEN.exec(line);
    if (memory) {
      closeFile(index);
      openSection(index, "memory");
      fileStart = index;
      filePath = memory[1] ?? line;
      return;
    }

    if (SKILLS_INTRO.test(line) || SKILLS_OPEN.test(line)) {
      closeFile(index);
      openSection(index, "skills");
      if (SKILLS_OPEN.test(line)) catalogue = [line];
      return;
    }

    if (CATALOG_OPEN.test(line)) {
      closeFile(index);
      openSection(index, "tools");
      return;
    }

    if (MCP_OPEN.test(line)) {
      closeFile(index);
      openSection(index, "mcp");
      return;
    }

    if (ENV_OPEN.test(line) || ENV_CLOSE.test(line) || DATE_OPEN.test(line)) {
      closeFile(index);
      openSection(index, "environment");
      return;
    }

    // A memory file ends wherever the next section begins.
    if (fileStart >= 0 && opensOtherSection(line)) {
      closeFile(index);
      openSection(index, "system");
    }
  });

  closeSection(lines.length);
  closeFile(lines.length);
  if (catalogue) skills.push(...parseSkillCatalogue(catalogue.join("\n")));

  return { lines, sectionSpans, memoryFiles, skills };
}

function schemaText(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

/**
 * Measures a whole snapshot with a real tokenizer.
 *
 * `system` and `tools` are the fixed overhead every request pays; `messages`
 * is the part that grows with the conversation.
 *
 * The Code Mode catalogue needs care. When it is present it sits inside the
 * system prompt's `tools` section, and the same builtins appear a second time
 * as real definitions in the request body. Both copies are genuine prompt
 * content and the provider charges for both, so both are counted — but the
 * catalogue has to be pulled out of the blanket `tools` figure and split by
 * namespace, or MCP cost would be invisible inside the builtin bucket and the
 * definitions would be counted twice.
 */
export async function measure(input: {
  system: SystemPart[];
  tools: Record<string, ToolDefinition>;
  /** Tool names known to come from an MCP server, and which server. */
  mcpTools?: Record<string, string>;
  /**
   * Namespace names owned by a connected MCP server.
   *
   * The Code Mode catalogue is parsed from each system part here rather than
   * passed in, because its line indices are only meaningful against the exact
   * string it was parsed from. A catalogue parsed from the joined parts and
   * applied to one part's lines removes the wrong rows, and the catalogue is
   * then counted twice.
   */
  mcpNamespaces?: string[];
  messages: MessageLike[];
  tokenizer?: Tokenizer;
  /**
   * Token count of the entire serialized request body.
   *
   * Supplied by the caller, which has the body; counting it once here turns the
   * difference from the parts into a reported figure rather than a silent gap.
   */
  envelope?: number;
}): Promise<Measurement> {
  const count = input.tokenizer ?? heuristicTokenizer;
  const categories = emptyCategories();
  const memoryFiles: MemoryFile[] = [];
  const skills: SkillEntry[] = [];
  const tools: ToolEntry[] = [];
  const mcpTools = input.mcpTools ?? {};
  // A namespace name is its own server: the catalogue carries no other server
  // identity, and these names come from the MCP domain.
  const mcpNamespaces = new Set(input.mcpNamespaces ?? []);

  // Totals the catalogue section is replaced by, accumulated across parts.
  let catalogMcp = 0;
  let catalogBuiltin = 0;
  const catalogs: ParsedCatalog[] = [];

  for (const part of input.system ?? []) {
    const text = part?.text ?? "";
    const read = readSystemPart(text);

    for (const span of read.sectionSpans) {
      if (span.category !== "tools") {
        categories[span.category] += await count.count(read.lines.slice(span.start, span.end).join("\n"));
        continue;
      }

      // The catalogue lives inside the `tools` section, so it is parsed from
      // that section alone and never allowed to run past it.
      //
      // Parsed from the whole part it would swallow whatever follows the last
      // namespace — the skills catalogue, memory files, the environment block
      // — and charge them to the tool bucket while they are also counted in
      // their own categories, inflating every one of them.
      const section = read.lines.slice(span.start, span.end);
      const found = parseCatalog(section.join("\n"));
      if (!found) {
        categories.tools += await count.count(section.join("\n"));
        continue;
      }

      // Indices are relative to the section; lift them onto the part.
      const catalog: ParsedCatalog = {
        ...found,
        start: found.start + span.start,
        end: found.end + span.start,
        namespaces: found.namespaces.map((namespace) => ({
          ...namespace,
          start: namespace.start + span.start,
          end: namespace.end + span.start,
        })),
      };
      catalogs.push(catalog);
      categories.tools += await count.count(outsideCatalog(read, catalog, span.start, span.end));
    }

    // Memory files and skills are counted from their own spans, so the detail
    // lists are slices of the same totals the bars above them are drawn from.
    for (const file of read.memoryFiles) {
      file.tokens = await count.count(read.lines.slice(file.start, file.end).join("\n"));
      memoryFiles.push({ path: file.path, tokens: file.tokens });
    }
    for (const skill of read.skills) {
      skill.tokens = await count.count(skill.text);
      skills.push({ id: skill.id, name: skill.name, tokens: skill.tokens });
    }
  }

  // Per-namespace and per-tool cost of the catalogue.
  for (const catalog of catalogs) {
    for (const namespace of catalog.namespaces) {
      const isMcp = mcpNamespaces.has(namespace.name);
      for (const entry of namespace.tools) {
        const tokens = await count.count(entry.text);
        const name = entry.path.split(".").pop() ?? entry.path;
        tools.push({ name, tokens, mcp: isMcp, ...(isMcp ? { server: namespace.name } : {}) });
        if (isMcp) {
          catalogMcp += tokens;
          categories.mcp += tokens;
        } else {
          catalogBuiltin += tokens;
          categories.tools += tokens;
        }
      }
      // The namespace header and its preamble are prompt content too, and
      // belong to the namespace rather than to any one tool.
      const overhead = await count.count(namespace.text);
      tools.push({ name: `${namespace.name} (namespace)`, tokens: overhead, mcp: isMcp, ...(isMcp ? { server: namespace.name } : {}) });
      if (isMcp) {
        catalogMcp += overhead;
        categories.mcp += overhead;
      } else {
        catalogBuiltin += overhead;
        categories.tools += overhead;
      }
    }
    // The catalogue preamble — the `# Code Mode` heading, the usage rules, the
    // `search` signature — is builtin overhead, never an MCP server's.
    if (catalog.preamble) {
      const tokens = await count.count(catalog.preamble);
      catalogBuiltin += tokens;
      categories.tools += tokens;
    }
  }

  // Tool definitions from the request body.
  for (const [name, definition] of Object.entries(input.tools ?? {})) {
    // The tool name and its full schema are both prompt content; measuring the
    // description alone would badly understate the bucket.
    const text = `${name}\n${definition?.description ?? ""}\n${schemaText(definition?.input)}`;
    const tokens = await count.count(text);
    const server = mcpTools[name];
    if (server !== undefined) {
      tools.push({ name, tokens, mcp: true, server });
      categories.mcp += tokens;
    } else {
      tools.push({ name, tokens, mcp: false });
      categories.tools += tokens;
    }
  }

  for (const message of input.messages ?? []) {
    categories.messages += await count.count(`${message.role}\n${message.text}`);
  }

  const measuredTotal = CATEGORIES.reduce((sum, key) => sum + categories[key], 0);

  // Only meaningful with a real tokenizer: an estimate of the whole body and an
  // estimate of its parts would differ for reasons that say nothing.
  const envelope = input.envelope;
  const unattributed =
    input.tokenizer !== undefined && envelope !== undefined ? Math.max(0, envelope - measuredTotal) : 0;

  return {
    categories,
    memoryFiles: memoryFiles.sort((a, b) => b.tokens - a.tokens),
    skills: skills.sort((a, b) => b.tokens - a.tokens),
    tools: tools.sort((a, b) => b.tokens - a.tokens),
    measuredTotal,
    tokenized: input.tokenizer !== undefined,
    unattributed,
  };
}

/**
 * The lines of a `tools` section that the catalogue does not cover.
 *
 * The catalogue is attributed separately so its MCP namespaces can be pulled
 * out of the builtin bucket, and it must be excluded here or every namespace
 * after the first would be counted twice. Every namespace's range is removed,
 * not just the first, and the surrounding prose is kept.
 */
function outsideCatalog(read: SystemRead, catalog: ParsedCatalog, from: number, to: number): string {
  // The catalogue is excluded, preamble included, because the preamble is
  // charged separately as builtin Code Mode overhead; excluding only the
  // namespaces would count it twice.
  //
  // Bounded to the span on purpose. Returning the whole part would add the
  // sections that follow the catalogue — skills, memory, environment — to the
  // tool bucket a second time, and quietly inflate every one of them.
  const kept: string[] = [];
  for (let i = from; i < to; i++) {
    if (i >= catalog.start && i < catalog.end) continue;
    kept.push(read.lines[i] ?? "");
  }
  return kept.join("\n");
}

/** A conversation message, flattened to the text the model is charged for. */
export interface MessageLike {
  role: string;
  text: string;
}

/**
 * Rescales a measurement onto the provider's own reading.
 *
 * The provider's `input + cache.read + cache.write` is what it was actually
 * charged for occupying the window, and it is the only number that is exact for
 * the total. When a real tokenizer produced the parts, they are already close
 * enough that a small correction is the honest thing to do; it is skipped
 * entirely when a real tokenizer was in use, because at that point the parts
 * are measurements and quietly bending them would misrepresent them.
 *
 * The correction is only applied to estimated parts, where the alternative is a
 * total that does not match the bars beneath it.
 */
export function reconcile(measurement: Measurement, reportedTotal: number | undefined): Measurement {
  const measured = measurement.measuredTotal;
  if (!reportedTotal || reportedTotal <= 0 || measured <= 0) return measurement;
  if (measurement.tokenized) return { ...measurement, measuredTotal: reportedTotal };
  if (reportedTotal / measured < 0.5 || reportedTotal / measured > 2) return measurement;

  const scale = (value: number) => Math.round((value * reportedTotal) / measured);
  const categories = emptyCategories();
  for (const key of CATEGORIES) categories[key] = scale(measurement.categories[key]);

  // Rounding leaves the parts a token or two off the reported total; the
  // largest category absorbs the remainder so the bar is exact.
  const sum = CATEGORIES.reduce((acc, key) => acc + categories[key], 0);
  const drift = reportedTotal - sum;
  if (drift !== 0) {
    const biggest = CATEGORIES.reduce((a, b) => (categories[a] >= categories[b] ? a : b));
    categories[biggest] = Math.max(0, categories[biggest] + drift);
  }

  const rescale = <T extends { tokens: number }>(list: T[]): T[] => list.map((entry) => ({ ...entry, tokens: scale(entry.tokens) }));

  return {
    ...measurement,
    categories,
    memoryFiles: rescale(measurement.memoryFiles),
    skills: rescale(measurement.skills),
    tools: rescale(measurement.tools),
    measuredTotal: reportedTotal,
  };
}
