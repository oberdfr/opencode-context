/**
 * The Code Mode tool catalogue.
 *
 * When Code Mode is on, most tools do not appear as provider tool definitions.
 * They are described once, in the system prompt, as a catalogue of call
 * signatures that the `execute` tool dispatches. That includes every tool an
 * MCP server contributes, which is why MCP context cost cannot be found by
 * looking at the request's `tools` array alone — it is not there.
 *
 * The catalogue is a flat, line-oriented format, verified against a live
 * session:
 *
 *     - chrome-devtools (30 tools, 4 shown) // Some description.
 *       - tools["chrome-devtools"].close_page({
 *         // doc comment
 *         pageId: number,
 *       }): Promise<unknown> // Closes the page.
 *       - tools["chrome-devtools"].list_pages({
 *         ...
 *
 * A namespace header is a bullet at column 0; its tool entries are bullets
 * indented under it. Parsing that gives a per-namespace and per-tool breakdown,
 * which is what lets MCP servers be attributed to their own server rather than
 * folded into the builtin tool bucket.
 */

export interface CatalogTool {
  /** Dotted path as written, e.g. `tools["chrome-devtools"].list_pages`. */
  path: string;
  /** Namespace the tool belongs to, e.g. `chrome-devtools`. */
  namespace: string;
  /** The entry's text, verbatim, which is what the provider tokenizes. */
  text: string;
}

export interface CatalogNamespace {
  name: string;
  /** How many tools the namespace has in total, as the header states. */
  total: number;
  /** How many are actually listed, which is usually fewer. */
  listed: number;
  /** The header's trailing description, when present. */
  description?: string;
  /** Start and end line of the namespace block, header included. */
  start: number;
  end: number;
  /**
   * The header line and any lines in the block that belong to no single tool.
   *
   * These are still prompt content, so they are measured and charged to the
   * namespace rather than dropped.
   */
  text: string;
  tools: CatalogTool[];
}

export interface ParsedCatalog {
  namespaces: CatalogNamespace[];
  /** Lines that belong to the catalogue but to no namespace. */
  preamble: string;
  /** First and last line of the catalogue, so a caller can exclude it whole. */
  start: number;
  end: number;
}

/** A namespace header: `- name (N tools[, M shown]) // description`. */
const NAMESPACE = /^- ([^\s(]+) \((\d+) tools(?:,\s*(\d+) shown)?\)\s*(?:\/\/\s*(.*))?$/;

/**
 * A tool entry: an indented bullet naming a call path.
 *
 * Two spellings occur and both must match: `tools.browser.tabs.list` for a
 * plain namespace, and `tools["chrome-devtools"].close_page` for a bracketed
 * one. Only whitespace, an opening paren and an opening brace terminate the
 * path, so both are captured whole.
 */
const TOOL_ENTRY = /^\s+- (tools[^\s({]*)\(/;

/**
 * Splits the Code Mode catalogue into namespaces and their tools.
 *
 * Returns nothing when the text is not a catalogue, so the caller can leave
 * whatever it already attributed alone rather than overwriting it with a
 * confident-looking empty result.
 */
export function parseCatalog(text: string): ParsedCatalog | undefined {
  if (!text || !text.includes("# Code Mode")) return undefined;

  const lines = text.split("\n");
  // The catalogue begins at its heading; everything to the end belongs to it.
  const start = lines.findIndex((line) => line.startsWith("# Code Mode"));
  if (start < 0) return undefined;
  // Provisional; narrowed to the real end once the namespaces are known.
  let end = lines.length;
  const namespaces: CatalogNamespace[] = [];
  let preamble: string[] = [];
  let current: CatalogNamespace | undefined;
  /** Accumulated lines of the tool entry being read. */
  let entry: { path: string; lines: string[] } | undefined;
  /** Header line plus block lines that belong to no single tool. */
  let overhead: string[] = [];

  const flushEntry = () => {
    if (!entry || !current) return;
    const name = lastSegment(entry.path);
    current.tools.push({ path: entry.path, namespace: current.name, text: entry.lines.join("\n") });
    entry = undefined;
  };
  const closeNamespace = (at: number) => {
    flushEntry();
    if (!current) return;
    current.end = at;
    current.text = overhead.join("\n");
    namespaces.push(current);
    current = undefined;
    overhead = [];
  };

  lines.forEach((line, index) => {
    // A namespace header always wins, and it terminates whatever entry was
    // being read: headers sit at column 0, entries never do.
    const header = NAMESPACE.exec(line);
    if (header && !/^\s/.test(line)) {
      closeNamespace(index);
      const [, name = "", totalText, shownText, description] = header;
      const total = Number(totalText ?? 0);
      overhead = [line];
      current = {
        name,
        total,
        listed: shownText !== undefined ? Number(shownText) : total,
        ...(description ? { description } : {}),
        start: index,
        end: lines.length,
        text: line,
        tools: [],
      };
      return;
    }

    if (current) {
      if (TOOL_ENTRY.test(line)) {
        flushEntry();
        const path = TOOL_ENTRY.exec(line)?.[1] ?? "";
        entry = { path, lines: [line] };
        return;
      }
      if (entry) {
        entry.lines.push(line);
        return;
      }
      // Still inside the namespace, but not inside a tool: a separator, a
      // section heading, or the blank line before the next namespace.
      overhead.push(line);
      return;
    }

    // Only from the heading onwards. Anything before it is ordinary prompt
    // content that the caller's own segmentation already attributes, and
    // claiming it here would move it into the tool bucket.
    if (index >= start) preamble.push(line);
  });

  closeNamespace(lines.length);

  // The catalogue ends at its last namespace, not at the end of the part.
  //
  // The `# Code Mode` section is only the head of a much larger `tools` section
  // that also holds the skills catalogue, memory files and the environment
  // block. Treating everything after the heading as catalogue would claim those
  // for the tool bucket and count them a second time.
  end = namespaces.length > 0 ? namespaces[namespaces.length - 1]!.end : start;
  if (end <= start) preamble = [];

  return { namespaces, preamble: preamble.join("\n"), start, end };
}

/** `tools["chrome-devtools"].list_pages` → `list_pages`. */
function lastSegment(path: string): string {
  const cleaned = path.replace(/^tools\./, "").replace(/^tools\[.*?\]\./, "");
  const parts = cleaned.split(".");
  return parts[parts.length - 1] ?? cleaned;
}
