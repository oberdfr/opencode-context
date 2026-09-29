/**
 * opencode-context — terminal half.
 *
 * Registers `/context` and renders the report in a dialog. Measuring the prompt
 * is the server half's job, so this file is only concerned with presentation.
 *
 * The dialog sizes itself to its content and scrolls when the content does not
 * fit, because a report with a dozen tools and a long skills catalogue is
 * taller than a short terminal and an unscrollable dialog would simply be
 * unreachable.
 */

import { createRoot, createSignal } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import {
  ContextRpc,
  CONTEXT_CATEGORIES,
  CONTEXT_CATEGORY_LABELS,
  parseContextReport,
  type ContextCategory,
  type ContextItem,
  type ContextReport,
} from "./rpc.ts";
import {
  bar,
  fillFraction,
  fillTone,
  formatPath,
  formatPercent,
  formatTokens,
  formatUsage,
  strong,
  windowBar,
  BAR_WIDTH,
} from "./format.ts";

const CLOSE_COMMAND_ID = "opencode-context.close";
const SHOW_COMMAND_ID = "opencode-context.show";
const REFRESH_COMMAND_ID = "opencode-context.refresh";

/** How long the report may take before it is reported as failed. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Column width reserved for the per-item path/name lists. */
const ITEM_COLUMN = 30;

/**
 * Tallest the dialog may grow, as a share of the terminal.
 *
 * The dialog is centred and scrollable, so a cap is what keeps a long report
 * from running off the bottom of a short window.
 */
const MAX_VIEWPORT_PERCENT = 70;

const EMPTY_REPORT: ContextReport = {
  generatedAt: 0,
  used: 0,
  limit: 0,
  exact: false,
  tokenized: false,
  categories: {},
  memoryFiles: [],
  skills: [],
  tools: [],
  notes: [],
};

/** Fails a request that never settles, so the dialog cannot wait forever. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface View {
  report: ContextReport;
  loading: boolean;
  error: string | null;
}

export default Plugin.define({
  id: "opencode-context.tui",
  setup(context) {
    const rpc = context.client.rpc(ContextRpc);
    // `storage.memory` returns a reactive store, so the cached report is read as
    // a property. A wrapper object is used because the store's value type is
    // constrained to non-null.
    const [cache, patchCache] = context.storage.memory("report", { initial: { last: EMPTY_REPORT } });

    // Live view state, owned by a Solid root created on open and disposed on
    // close, so the dialog re-renders in place rather than being torn down and
    // rebuilt while a request is in flight.
    let readView: (() => View) | undefined;
    let writeView: ((next: View | ((view: View) => View)) => void) | undefined;
    let disposeRoot: (() => void) | undefined;
    // Whether a context dialog is on screen.
    //
    // Deliberately a plain boolean rather than a signal. This value gates a
    // keymap command, and the host resolves `enabled` through a reactive
    // computation, so a signal-free read can be evaluated once and cached with
    // no way to re-check it. Depending on that re-evaluation made escape
    // unreliable, so the binding is registered unconditionally and the state is
    // checked here instead, where it is always live.
    let dialogIsOpen = false;

    const close = () => {
      // Guarded so an escape press that lands with no dialog on screen cannot
      // clear a dialog belonging to something else.
      if (!dialogIsOpen) return;
      dialogIsOpen = false;
      if (disposeRoot) {
        disposeRoot();
        disposeRoot = undefined;
      }
      readView = undefined;
      writeView = undefined;
      try {
        context.ui.dialog.clear();
      } catch {
        // The host may already have torn the dialog down; nothing left to do.
      }
    };

    /**
     * The session the report should describe.
     *
     * Read from the router rather than tracked in state: the command can be
     * bound globally, so the current route is the only trustworthy source of
     * which session is on screen.
     */
    const currentSessionID = (): string | undefined => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };

    /**
     * Monotonic counter identifying the newest refresh, so a request that
     * resolves after a retry cannot revert the dialog to older numbers.
     */
    let latestGeneration = 0;

    const refresh = () => {
      const apply = writeView;
      if (!apply) return;

      const sessionID = currentSessionID();
      if (!sessionID) {
        // Nothing to measure outside a session, and no request to make.
        apply((view) => ({ ...view, loading: false, error: "Open a session to see its context usage." }));
        return;
      }

      const generation = (latestGeneration += 1);
      const isCurrent = () => latestGeneration === generation;
      apply((view) => ({ ...view, loading: true }));

      // The call is wrapped so a synchronous throw is handled like a rejection:
      // letting it escape would leave the dialog loading for good.
      let request: Promise<unknown>;
      try {
        request = Promise.resolve(rpc.report({ sessionID }));
      } catch (error: unknown) {
        request = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }

      void withTimeout(request, REQUEST_TIMEOUT_MS)
        .then((result) => {
          if (!isCurrent() || !dialogIsOpen) return;
          const report = parseContextReport(result);
          patchCache((draft) => {
            draft.last = report;
          });
          apply((view) => ({ report, loading: false, error: null }));
        })
        .catch((error: unknown) => {
          if (!isCurrent() || !dialogIsOpen) return;
          // A cached report stays on screen: the point of the cache is that a
          // failed refresh does not blank the dialog.
          apply((view) => ({ ...view, loading: false, error: error instanceof Error ? error.message : String(error) }));
        });
    };

    const open = () => {
      // A second /context while one is open refreshes rather than stacking.
      if (dialogIsOpen) {
        refresh();
        return;
      }
      dialogIsOpen = true;

      // createRoot passes its disposer to the callback, so the root can be torn
      // down later to release the signals it owns.
      disposeRoot = createRoot((dispose) => {
        // Any cached report is on screen from the first frame, and the view
        // starts out loading so the wait is visible.
        const [signal, setSignal] = createSignal<View>({ report: cache.last, loading: true, error: null });
        readView = signal;
        writeView = setSignal;
        return dispose;
      });

      // `centered` is what was missing: without it the host anchored the dialog
      // to the bottom of a very tall report, leaving the top of the screen
      // empty. The cap keeps a long report from exceeding the window.
      context.ui.dialog.set({ size: "large", centered: true });
      context.ui.dialog.show(
        () => <ContextView read={readView!} />,
        () => close(),
      );

      // Always a fresh read: the cache only decides what the first frame shows.
      refresh();
    };

    // The host's resolved theme type is not resolvable from this package, so
    // tokens are read defensively: an unexpected shape falls back to the
    // documented foreground tokens instead of rendering nothing.
    const theme = context.theme as unknown as Record<string, any>;
    const text = (theme.text ?? {}) as Record<string, string | undefined>;
    const base = text.base;
    const muted = text.muted ?? base;

    const toneColor = (tone: ReturnType<typeof fillTone>) => {
      switch (tone) {
        case "ok":
          return theme.success?.base ?? base;
        case "warn":
          return theme.warning?.base ?? base;
        default:
          return theme.error?.base ?? base;
      }
    };

    /** Categories with a non-zero cost, largest first. */
    const ranked = (report: ContextReport): { key: ContextCategory; tokens: number }[] =>
      CONTEXT_CATEGORIES.flatMap((key) => {
        const tokens = report.categories[key];
        return tokens === undefined || tokens <= 0 ? [] : [{ key, tokens }];
      }).sort((a, b) => b.tokens - a.tokens);

    /**
     * One labelled list of items with their cost.
     *
     * Everything is listed. A cap would only hide data the reader came here
     * for, and the dialog scrolls, so there is nothing left for one to protect.
     */
    const ItemList = (props: { title: string; items: ContextItem[]; unit: string; showServer?: boolean }) => {
      const items = () => props.items;
      return (
        <box flexDirection="column" marginTop={1}>
          <text fg={muted}>{strong(props.title)}</text>
          {items().length === 0 ? (
            <text fg={muted} opacity={0.7}>{`  none`}</text>
          ) : (
            items().map((item) => (
              <box flexDirection="row">
                <text fg={props.showServer && item.server ? theme.accent?.base ?? base : base}>
                  {`  ${formatPath(item.name, ITEM_COLUMN).padEnd(ITEM_COLUMN)}`}
                </text>
                {props.showServer && item.server ? (
                  <text fg={muted} opacity={0.8}>{`${(item.server + " ").padEnd(14)}`}</text>
                ) : null}
                <text fg={muted}>{`${formatTokens(item.tokens)} ${props.unit}`}</text>
              </box>
            ))
          )}
        </box>
      );
    };

    /** One line per MCP connector: its name, how much it costs, how many tools. */
    const McpList = (props: { servers: { name: string; tokens: number; detail: string }[] }) => (
      <box flexDirection="column" marginTop={1}>
        <text fg={muted}>{strong("MCP connectors")}</text>
        {props.servers.map((server) => (
          <box flexDirection="row">
            <text fg={theme.accent?.base ?? base}>{`  ${formatPath(server.name, ITEM_COLUMN).padEnd(ITEM_COLUMN)}`}</text>
            <text fg={muted}>{`${formatTokens(server.tokens)} tokens  `}</text>
            <text fg={muted} opacity={0.7}>{`${server.detail}`}</text>
          </box>
        ))}
      </box>
    );

    const ContextView = (props: { read: () => View }) => {
      const current = () => props.read();
      const report = () => current().report;
      const used = () => report().used;
      const limit = () => report().limit;
      const threshold = () => report().compactionThreshold;
      const fraction = () => fillFraction(used(), limit());
      const tone = () => fillTone(used(), limit(), threshold());
      const free = () => Math.max(0, limit() - used());
      const rows = () => ranked(report());
      const breakdown = () => CONTEXT_CATEGORIES.map((key) => report().categories[key] ?? 0).reduce((a, b) => a + b, 0);
      // A reserve is only worth drawing once the window is known, and only if
      // the trigger actually falls inside it.
      const reserve = () => {
        if (limit() <= 0) return undefined;
        const t = threshold();
        return t !== undefined && t > 0 && t < limit() ? t : undefined;
      };
      /** Width of the `=` run that mirrors the compaction marker's offset. */
      /** Request framing the categories do not account for. */
      const framing = () => report().unattributed ?? 0;
      const reserveCells = () => {
        const mark = reserve();
        if (mark === undefined || limit() <= 0) return 0;
        return Math.max(1, Math.floor((1 - mark / limit()) * BAR_WIDTH));
      };
      const builtinTools = () => report().tools.filter((tool) => !tool.mcp);

      /**
       * One row per MCP connector, not per tool.
       *
       * A connected server can contribute thirty or more tools, and listing
       * every one buries the rest of the report under a wall of names. What
       * actually matters is which connector is costing what, so the per-tool
       * figures are summed per server and the tool count is kept for context.
       */
      const mcpServers = () => {
        const byServer = new Map<string, { tokens: number; count: number }>();
        for (const tool of report().tools) {
          if (!tool.mcp || !tool.server) continue;
          const entry = byServer.get(tool.server) ?? { tokens: 0, count: 0 };
          entry.tokens += tool.tokens;
          entry.count += 1;
          byServer.set(tool.server, entry);
        }
        return [...byServer.entries()]
          .map(([name, entry]) => ({
            name,
            tokens: entry.tokens,
            count: entry.count,
            detail: `${entry.count} tool${entry.count === 1 ? "" : "s"}`,
          }))
          .sort((a, b) => b.tokens - a.tokens);
      };

      // One honest sentence about where the numbers came from, rather than a
      // blanket claim of accuracy the report may not support.
      /**
       * One honest sentence about where the numbers came from.
       *
       * A general BPE standing in for an unrecognised model is a different
       * claim from the model's own tokenizer, and is named as such rather than
       * being blended into a single "accurate".
       */
      const provenance = () => {
        if (current().error) return current().error!;
        const name = report().tokenizer;
        if (report().tokenized && report().exact) {
          return `Counted from the request body with the ${name ?? "model"} tokenizer.`;
        }
        if (report().tokenized) {
          return `Counted with ${name ?? "a general BPE"}, which is not this model's own tokenizer.`;
        }
        if (report().exact) return "Total from the provider; the split below is an estimate.";
        return "Estimated from the assembled prompt; the provider has not reported this window yet.";
      };

      return (
        <box
          flexDirection="column"
          // Grows to fill the frame the host gave the dialog, which is what
          // hands the leftover height to the scrollbox below.
          //
          // `flexGrow` rather than `height="100%"`: a percentage resolves
          // against the whole terminal and drags the dialog frame out to fill
          // it, while a flex child simply takes the space its parent already
          // has. A height is what made the dialog enormous.
          flexGrow={1}
          // Only a cap, so a long report cannot push past a short terminal.
          // The scrollbox below absorbs whatever the cap cuts off.
          maxHeight={`${MAX_VIEWPORT_PERCENT}%`}
          justifyContent="flex-start"
          paddingLeft={3}
          paddingRight={3}
          paddingBottom={1}
          paddingTop={0}
          // Second, independent way out. A custom dialog owns its own
          // dismissal, so the root renderable takes focus and closes on escape
          // directly, without relying on the host routing keys to plugin
          // keymap layers while a dialog is on screen.
          focusable
          onKeyDown={(event) => {
            if (event.name === "escape") close();
          }}
        >
          {/* Header: title on the left, dismiss hint on the right. Pinned
              outside the scroll area so the escape affordance is always
              visible, however far down the reader has scrolled. */}
          <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
            <text fg={base}>{strong("Context Usage")}</text>
            <text
              fg={muted}
              onMouseDown={(event: unknown) => {
                (event as { stopPropagation?: () => void }).stopPropagation?.();
                close();
              }}
            >
              esc
            </text>
          </box>

          {/* The gauge, also pinned: the state of the window is the reason the
              dialog was opened and must not require scrolling to see. */}
          <box flexDirection="column" marginTop={1} flexShrink={0}>
            <text fg={base}>{report().model ?? "unknown model"}</text>
            <box flexDirection="row" marginTop={1} marginBottom={1}>
              <text fg={toneColor(tone())}>
                {windowBar({ used: used(), limit: limit(), ...(reserve() !== undefined ? { threshold: reserve() } : {}) })}
              </text>
              <text fg={base}>{`  ${formatUsage(used(), limit())} tokens`}</text>
              <text fg={muted}>{limit() > 0 ? `  (${formatPercent(fraction())})` : ""}</text>
              {current().loading ? <text fg={muted}>{`  ·`}</text> : null}
            </box>
            <text fg={muted}>
              {`Free space: ${formatTokens(free())}${limit() > 0 ? ` (${formatPercent(1 - fraction())})` : ""}`}
            </text>
            {/* The compaction marker sits on the bar; the run of `=` beneath it
                spans exactly the same distance to the end of the window, so the
                two rows read as one gauge and the reserve is visible as width
                rather than as a number to be interpreted. */}
            {reserve() !== undefined ? (
              <text fg={muted}>
                {`Compaction threshold: ${formatTokens(report().compactionBuffer ?? 0)} (${formatPercent((report().compactionBuffer ?? 0) / limit())})`}
              </text>
            ) : null}
            <text fg={muted} opacity={0.7}>{provenance()}</text>
          </box>

          {/* Everything else scrolls. `flexGrow` lets it take whatever height
              is left inside the dialog once the gauge and footer have their
              share; combined with the cap above this is what makes the area
              grow with the window instead of the window growing with it. */}
          <scrollbox
            scrollY
            flexGrow={1}
            flexShrink={1}
            flexBasis="auto"
            marginTop={1}
            // Sticky: the scrollbar stays hidden until the reader scrolls and
            // then fades back out. A permanent scrollbar would steal a column
            // from a report that is almost entirely columns of text.
            stickyScroll
            stickyStart="top"
            verticalScrollbarOptions={{ showArrows: false }}
          >
            <box flexDirection="column" flexShrink={0}>
              <text fg={base}>{strong("Usage by category")}</text>
              {rows().length === 0 ? (
                <text fg={muted} opacity={0.8}>Nothing measured yet.</text>
              ) : (
                rows().map((row) => (
                  <box flexDirection="row">
                    <text fg={base}>{`  ${CONTEXT_CATEGORY_LABELS[row.key].padEnd(14)}`}</text>
                    <text fg={muted}>{`${bar(breakdown() > 0 ? row.tokens / breakdown() : 0, 10)} `}</text>
                    <text fg={base}>{`${formatTokens(row.tokens).padStart(6)} tokens`}</text>
                    <text fg={muted}>{`  (${formatPercent(breakdown() > 0 ? row.tokens / breakdown() : 0)})`}</text>
                  </box>
                ))
              )}

              {report().notes.map((note) => (
                <text fg={muted} opacity={0.7}>{`  ${note}`}</text>
              ))}

              <ItemList title="Memory files" items={report().memoryFiles} unit="tokens" />
              <ItemList title="Skills" items={report().skills} unit="tokens" />

              {mcpServers().length > 0 ? <McpList servers={mcpServers()} /> : null}

              <ItemList title="Tools" items={builtinTools()} unit="tokens" />

              {/* The categories measure prompt content; the provider also
                  counts the JSON envelope around it. Naming the remainder is
                  what lets the parts be reconciled against the headline rather
                  than looking short by an unexplained amount. */}
              {framing() > 0 ? (
                <text fg={muted} opacity={0.7}>
                  {`  + ${formatTokens(framing())} request framing (JSON envelope, model, generation settings)`}
                </text>
              ) : null}
            </box>
          </scrollbox>

          {/* Footer: the refresh control, styled and clickable like the host's key hints. */}
          <box flexDirection="row" marginTop={1} flexShrink={0}>
            <text
              fg={muted}
              onMouseDown={(event: unknown) => {
                (event as { stopPropagation?: () => void }).stopPropagation?.();
                if (current().loading) return;
                refresh();
              }}
            >
              {strong("r")} to refresh
            </text>
          </box>
        </box>
      );
    };

    // The keymap layer must be created from inside the app's render tree: the
    // host keeps its keymap state in a reactive context, and reaching for it
    // during setup runs outside that tree and fails with "Keymap.Provider is
    // missing". Claiming an `app` slot places this render inside the tree, and
    // the disposer returned by `ui.slot` is returned from setup.
    return context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 20,
          commands: [
            {
              id: SHOW_COMMAND_ID,
              title: "Context usage",
              description: "Show how the context window is being used",
              group: "opencode-context",
              palette: true,
              slash: { name: "context", aliases: ["context-usage", "ctx"] },
              run: open,
            },
            {
              id: REFRESH_COMMAND_ID,
              title: "Refresh context usage",
              group: "opencode-context",
              bind: "r",
              // No `enabled` gate, for the same reason as the close command: the
              // host resolves `enabled` reactively and may cache the result.
              run: () => {
                if (!dialogIsOpen) return false;
                refresh();
                return false;
              },
            },
            {
              id: CLOSE_COMMAND_ID,
              title: "Close context usage",
              group: "opencode-context",
              bind: "escape",
              // No `enabled` gate. The host resolves `enabled` reactively, so
              // gating the binding on live state risks it being evaluated once
              // and cached. `close()` checks whether a dialog is actually open
              // instead, and returns false so the host still handles the key it
              // was already seeing.
              run: () => {
                close();
                return false;
              },
            },
          ],
          // A command's `bind` is inert unless its id is listed here, which is
          // why listing the close command is what makes escape reach it.
          bindings: [CLOSE_COMMAND_ID, REFRESH_COMMAND_ID],
        }));
        return null;
      },
    });
  },
});
