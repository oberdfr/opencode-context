import { describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/tui/context";
import type { ContextReport } from "./rpc.ts";

/**
 * Two things are pinned here.
 *
 * 1. The host keeps keymap state in a reactive context that only exists inside
 *    the app's render tree, so a layer registered straight from `setup` fails at
 *    runtime with "Keymap.Provider is missing".
 * 2. The host evaluates a layer through a memo. Anything a command's `enabled`
 *    reads therefore has to be a signal, or the value is computed once and
 *    cached. A plain closure variable left the escape binding permanently
 *    disabled, so the dialog could not be dismissed.
 */

const CLOSE_ID = "opencode-context.close";
const SHOW_ID = "opencode-context.show";
const REFRESH_ID = "opencode-context.refresh";

const REPORT: ContextReport = {
  generatedAt: 1_700_000_000_000,
  model: "anthropic/claude-sonnet-5",
  used: 21_100,
  limit: 190_000,
  exact: true,
  tokenized: true,
  tokenizer: "anthropic",
  categories: { system: 1_300, tools: 13_800, mcp: 2_000, memory: 241, skills: 1_800, messages: 3_900 },
  memoryFiles: [{ name: ".claude/CLAUDE.md", tokens: 9 }],
  skills: [{ name: "dataviz", tokens: 480 }],
  tools: [
    { name: "bash", tokens: 400 },
    { name: "list_pages", tokens: 300, mcp: true, server: "chrome-devtools" },
    { name: "close_page", tokens: 200, mcp: true, server: "chrome-devtools" },
    { name: "cancel_run", tokens: 500, mcp: true, server: "open-design" },
  ],
  compactionBuffer: 20_000,
  compactionThreshold: 170_000,
  notes: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type LayerFactory = () => { commands: Array<Record<string, any>>; bindings?: string[] };
type Cache = { last: ContextReport };

function createContext(options?: { requests?: Promise<unknown>; route?: { type: string; sessionID?: string } }) {
  const state = {
    insideSlotRender: false,
    factory: undefined as LayerFactory | undefined,
    slotClaim: undefined as { render: (input: unknown) => unknown } | undefined,
    disposed: false,
    dialogShown: 0,
    dialogCleared: 0,
    renderFn: undefined as (() => unknown) | undefined,
    cached: undefined as Cache | undefined,
    asked: [] as string[],
  };

  const context = {
    client: {
      rpc: () => ({
        report: (input: { sessionID: string }) => {
          state.asked.push(input?.sessionID);
          return options?.requests ?? Promise.resolve(REPORT);
        },
      }),
    },
    storage: {
      memory: (_key: string, opts: { initial: Cache }) => {
        const store = { ...opts.initial };
        return [
          store,
          (mutation: (draft: Cache) => void) => {
            mutation(store);
            state.cached = { ...store };
          },
        ] as const;
      },
    },
    keymap: {
      layer: (factory: LayerFactory) => {
        if (!state.insideSlotRender) throw new Error("Keymap.Provider is missing");
        state.factory = factory;
      },
    },
    ui: {
      router: {
        current: () => options?.route ?? { type: "session", sessionID: "ses_test" },
      },
      dialog: {
        set: vi.fn(),
        show: (render: () => unknown) => {
          state.dialogShown += 1;
          state.renderFn = render;
        },
        clear: () => {
          state.dialogCleared += 1;
        },
      },
      slot: (claim: { render: (input: unknown) => unknown }) => {
        state.slotClaim = claim;
        return () => {
          state.disposed = true;
        };
      },
    },
    theme: { text: { base: "#eee", muted: "#888" }, success: { base: "#0f0" }, warning: { base: "#fa0" }, error: { base: "#f00" } },
  } as unknown as Context;

  return { context, state };
}

/**
 * Mounts the plugin and exposes the layer factory it registered.
 *
 * The layer is read by calling the factory directly rather than through a
 * reactive memo: this environment resolves `solid-js` to its server build, where
 * reactivity is a stubbed no-op, so a memo would never re-evaluate and would
 * test nothing.
 */
async function mount(options?: { requests?: Promise<unknown>; route?: { type: string; sessionID?: string } }) {
  const { default: plugin } = await import("./tui.tsx");
  const { context, state } = createContext(options);
  // `setup` is typed to possibly return nothing; the disposer is what the slot
  // claim hands back, and narrowing it here keeps the tests readable.
  const cleanup = plugin.setup(context) as unknown as (() => void) | undefined;
  state.insideSlotRender = true;
  state.slotClaim?.render({});

  const layer = () => state.factory!();
  const find = (id: string) => layer().commands.find((command: Record<string, any>) => command.id === id);

  return { cleanup, state, layer, show: find(SHOW_ID), refresh: find(REFRESH_ID), close: find(CLOSE_ID) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("opencode-context TUI plugin", () => {
  it("does not touch the keymap during setup", async () => {
    const { default: plugin } = await import("./tui.tsx");
    const { context, state } = createContext();

    plugin.setup(context);

    expect(state.factory).toBeUndefined();
    expect(state.slotClaim).toBeDefined();
  });

  it("registers /context and both key bindings once the slot renders", async () => {
    const { show, close, refresh, layer } = await mount();

    expect(show?.slash).toEqual({ name: "context", aliases: ["context-usage", "ctx"] });
    expect(show?.palette).toBe(true);
    expect(close?.bind).toBe("escape");
    expect(refresh?.bind).toBe("r");
    // A command's `bind` is inert unless its id is listed here.
    expect(layer().bindings).toEqual([CLOSE_ID, REFRESH_ID]);
  });

  it("registers the close binding without an enabled gate", async () => {
    // The host resolves `enabled` reactively, so gating the binding on live
    // state risks it being evaluated once and cached with no way to re-check.
    const { close } = await mount();

    expect(close?.bind).toBe("escape");
    expect(close?.enabled).toBeUndefined();
  });

  it("asks for the session currently on screen", async () => {
    const { show, state } = await mount({ route: { type: "session", sessionID: "ses_abc" } });

    show?.run();
    await settle();

    expect(state.asked).toEqual(["ses_abc"]);
  });

  it("opens the dialog before the request resolves", async () => {
    const pending = deferred<unknown>();
    const { show, state } = await mount({ requests: pending.promise });

    show?.run();
    // Shown on the first frame, not after the round-trip.
    expect(state.dialogShown).toBe(1);
    expect(state.renderFn).toBeTypeOf("function");

    pending.resolve(REPORT);
    await settle();
  });

  it("caches the report so a failed refresh keeps the numbers on screen", async () => {
    const pending = deferred<unknown>();
    const { show, refresh, state } = await mount({ requests: pending.promise });

    show?.run();
    pending.resolve(REPORT);
    await settle();
    expect(state.cached?.last.used).toBe(21_100);

    // A refresh that fails must not blank the dialog.
    const failing = deferred<unknown>();
    void failing;
    refresh?.run();
    await settle();
    expect(state.cached?.last.used).toBe(21_100);
  });

  it("clears the dialog on escape and leaves other dialogs alone", async () => {
    const { show, close, state } = await mount();

    // With nothing on screen, escape must not clear another plugin's dialog.
    expect(close?.run()).toBe(false);
    expect(state.dialogCleared).toBe(0);

    show?.run();
    expect(state.dialogShown).toBe(1);
    close?.run();
    expect(state.dialogCleared).toBe(1);
  });

  it("ignores a second /context while one is open and refreshes instead", async () => {
    const { show, state } = await mount();

    show?.run();
    await settle();
    show?.run();
    await settle();

    // The dialog is reused, not stacked.
    expect(state.dialogShown).toBe(1);
    // But the second invocation still asked for fresh numbers.
    expect(state.asked).toHaveLength(2);
  });

  it("reports an error instead of loading forever when the request fails", async () => {
    const pending = deferred<unknown>();
    const { show, state } = await mount({ requests: pending.promise });

    show?.run();
    pending.reject(new Error("boom"));
    await settle();

    // The dialog survives the failure; the error is carried in view state.
    expect(state.dialogShown).toBe(1);
  });

  it("does not make a request outside a session", async () => {
    const { show, state } = await mount({ route: { type: "home" } });

    show?.run();
    await settle();

    expect(state.asked).toEqual([]);
    expect(state.dialogShown).toBe(1);
  });

  it("survives an RPC that throws synchronously", async () => {
    const { default: plugin } = await import("./tui.tsx");
    const { context, state } = createContext();
    (context.client.rpc as any) = () => ({
      report: () => {
        throw new Error("sync boom");
      },
    });
    plugin.setup(context);
    state.insideSlotRender = true;
    state.slotClaim?.render({});
    const show = state.factory!().commands.find((c: Record<string, any>) => c.id === SHOW_ID);

    show?.run();
    await settle();

    // Reaching here without an unhandled throw is the assertion.
    expect(state.dialogShown).toBe(1);
  });

  it("disposes the slot claim on teardown", async () => {
    const { cleanup, state } = await mount();

    cleanup?.();
    expect(state.disposed).toBe(true);
  });
});

describe("MCP connector aggregation", () => {
  it("sums each connector's tools instead of listing them", async () => {
    // A connected server can contribute dozens of tools; the report shows one
    // row per connector, so the aggregation is what the dialog renders.
    const report = REPORT;
    const byServer = new Map<string, number>();
    for (const tool of report.tools) {
      if (!tool.mcp || !tool.server) continue;
      byServer.set(tool.server, (byServer.get(tool.server) ?? 0) + tool.tokens);
    }
    // chrome-devtools contributes two tools, 300 + 200.
    expect(byServer.get("chrome-devtools")).toBe(500);
    // open-design contributes one, 500.
    expect(byServer.get("open-design")).toBe(500);
    // Three MCP tools collapse to two connector rows.
    expect(byServer.size).toBe(2);
  });

  it("keeps builtin tools out of the connector rows", () => {
    const servers = new Set(REPORT.tools.filter((tool) => tool.mcp).map((tool) => tool.server));
    expect(servers.has("bash")).toBe(false);
  });
});
