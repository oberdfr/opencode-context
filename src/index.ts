/**
 * opencode-context — server half.
 *
 * Two hooks feed this, and the difference is the whole point of the plugin.
 *
 * `session.http.request` fires with the exact serialized JSON body handed to
 * the provider. That body is what the provider's tokenizer counted, so reading
 * it is the difference between measuring the prompt and guessing at it. It is
 * the primary source here.
 *
 * `session.context` fires with the prompt before serialization. It is kept as a
 * fallback for providers whose body is not JSON — a local endpoint, or anything
 * streaming a non-standard payload — and because it degrades more gracefully
 * than a parse failure.
 *
 * The provider's own usage report is the authority on the total; these two
 * hooks supply the breakdown that a single total cannot.
 */

import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { StorageDomain } from "@opencode/plugin/promise/storage";
import { ContextRpc, type ContextReport } from "./rpc.ts";
import { measure, reconcile, resolveTokenizer, type Measurement } from "./measure.ts";
import { parseRequestBody } from "./body.ts";

const PLUGIN_ID = "opencode-context";

/** Sessions kept in memory. Enough for a few tabs; the rest are re-snapshotted. */
const MAX_SNAPSHOTS = 8;

interface Options {
  /**
   * Token headroom OpenCode reserves for compaction.
   *
   * Only needed to override OpenCode's own `compaction.buffer`. When unset, the
   * same default formula OpenCode applies internally is used, so the marker on
   * the bar lands where compaction actually fires.
   */
  compactionBuffer?: number;
}

/** One captured request. */
interface Snapshot {
  system: { text: string }[];
  tools: Record<string, { description: string; input: unknown }>;
  /** Tool name to the MCP server that provided it. */
  mcpTools: Record<string, string>;
  /** Namespace names belonging to a connected MCP server. */
  mcpNamespaces: string[];
  messages: { role: string; text: string }[];
  model?: { providerID: string; modelID: string };
  capturedAt: number;
  /** Whether the prompt came from the serialized body rather than the hook. */
  fromBody: boolean;
  /** The raw serialized request body, kept so its token count can be derived. */
  body?: string;
}

/** Touches a key so a Map can evict least-recently-used entries. */
function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** Storage key for a session's captured prompt. */
const snapshotKey = (sessionID: string) => `context-snapshot/${sessionID}`;

/** How many sessions are kept on disk. */
const MAX_PERSISTED = 8;

/** A captured prompt larger than this is not worth writing to disk. */
const MAX_PERSIST_BYTES = 1_000_000;

/**
 * The part of a snapshot worth keeping across restarts.
 *
 * The raw request body is dropped: it is by far the largest field and is used
 * only for the framing figure, which is a nice-to-have that the report simply
 * omits when it is unavailable.
 */
type PersistedSnapshot = Omit<Snapshot, "body">;

export const ContextPlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options;
    const snapshots = new Map<string, Snapshot>();
    /**
     * Writes a capture through to durable storage.
     *
     * Failures are swallowed on purpose: persistence is a convenience that
     * makes a session readable after a restart, never a correctness
     * requirement, and it must not affect the capture it follows.
     */
    const persist = async (storage: StorageDomain, sessionID: string, snapshot: Snapshot) => {
      try {
        const { body: _body, ...durable } = snapshot;
        const encoded = JSON.stringify(durable);
        // A session that has grown a very long transcript is not worth the
        // disk; it still reports in memory while it is the active session.
        if (encoded.length > MAX_PERSIST_BYTES) return;
        await storage.set(snapshotKey(sessionID), JSON.parse(encoded));
        await prune(storage);
      } catch {
        // Nothing to do; the in-memory capture is unaffected.
      }
    };

    /** Drops all but the most recently captured sessions from disk. */
    const prune = async (storage: StorageDomain) => {
      try {
        const found = await storage.scan({ prefix: "context-snapshot/", limit: 200 });
        const entries = [...found.entries];
        if (entries.length <= MAX_PERSISTED) return;
        const withTime = entries
          .map((entry) => {
            const value = entry.value as { capturedAt?: unknown } | null;
            return { key: entry.key, at: typeof value?.capturedAt === "number" ? value.capturedAt : 0 };
          })
          .sort((a, b) => a.at - b.at);
        for (const stale of withTime.slice(0, withTime.length - MAX_PERSISTED)) {
          await storage.remove(stale.key);
        }
      } catch {
        // Pruning is housekeeping; leaving extra entries costs disk, not
        // correctness.
      }
    };

    /**
     * Restores a capture from a previous run.
     *
     * This is what makes `/context` work for a chat you switch back to: the
     * prompt that produced its window was captured when it last ran, and
     * survives even though the in-memory window has moved on.
     */
    const restore = async (sessionID: string): Promise<Snapshot | undefined> => {
      try {
        const raw = await ctx.storage.get(snapshotKey(sessionID));
        if (raw === undefined || raw === null) return undefined;
        const parsed = raw as unknown as PersistedSnapshot;
        if (!Array.isArray(parsed.system) || !Array.isArray(parsed.messages)) return undefined;
        return { ...parsed, mcpNamespaces: parsed.mcpNamespaces ?? [] } as Snapshot;
      } catch {
        return undefined;
      }
    };

    /** Tool name to MCP server, refreshed as servers connect. */
    let mcpOwners = new Map<string, string>();
    /** Names of connected MCP servers, which is what a catalogue namespace matches. */
    let mcpNamespacesOwn = new Set<string>();

    /**
     * Rebuilds the tool-to-server map.
     *
     * MCP servers connect after plugin setup, so this is refreshed on every
     * report rather than read once at load.
     *
     * A server's *name* is recorded whatever its status, because a namespace
     * appearing in the Code Mode catalogue means the prompt carries that
     * server, and dropping a `pending` server here misfiled its whole
     * description into the builtin bucket. Its *tools* are only recorded once
     * connected, because an unconnected server exposes none and attributing
     * them would invent a mapping that does not exist yet.
     */
    const refreshMcpOwners = async () => {
      try {
        const listed = await ctx.mcp.list();
        const owners = new Map<string, string>();
        const names = new Set<string>();
        for (const server of (listed?.data ?? []) as { name?: unknown; tools?: unknown; status?: unknown }[]) {
          if (typeof server?.name !== "string") continue;
          // `status` is a tagged object on the wire.
          const status = server.status as { status?: string } | string | undefined;
          const state = typeof status === "string" ? status : status?.status;
          names.add(server.name);
          if (state && state !== "connected") continue;
          for (const tool of (server.tools ?? []) as { name?: unknown }[]) {
            if (typeof tool?.name === "string") owners.set(tool.name, server.name);
          }
        }
        mcpOwners = owners;
        mcpNamespacesOwn = names;
      } catch {
        // Keep the previous map rather than losing attribution.
      }
    };

    /**
     * Captures the exact serialized body.
     *
     * Only `primary` requests are used: compaction and title requests are
     * auxiliary and their bodies do not describe the window the session is
     * working in. The hook is unscoped so the report follows whichever provider
     * a session happens to be on.
     */
    await ctx.session.hook("http.request", async (request) => {
      if (request.kind !== "primary") return;
      try {
        const text = await request.request.clone().text();
        const parsed = parseRequestBody(text);
        const model = request.model as { providerID?: unknown; id?: unknown } | undefined;
        const providerID = typeof model?.providerID === "string" ? model.providerID : undefined;
        const modelID = typeof model?.id === "string" ? model.id : undefined;
        // An unrecognised body yields nothing; storing it would replace a good
        // snapshot with an empty one.
        if (parsed.shape === "unknown" && parsed.system.length === 0 && Object.keys(parsed.tools).length === 0) return;

        const mcpTools: Record<string, string> = {};
        for (const name of Object.keys(parsed.tools)) {
          const server = mcpOwners.get(name);
          if (server !== undefined) mcpTools[name] = server;
        }

        // With Code Mode on, MCP tools are described in the system prompt's
        // catalogue rather than as request-body definitions. The catalogue
        // itself is parsed during measurement, where its line indices match
        // the text it came from; here only the server names are needed.
        const mcpNamespaces = [...mcpNamespacesOwn];

        const snapshot: Snapshot = {
            system: parsed.system,
            tools: parsed.tools,
            mcpTools,
            mcpNamespaces,
            messages: parsed.messages,
            ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
            capturedAt: Date.now(),
            fromBody: true,
            // The raw body is kept so the request framing can be counted later.
            // Counting it here would put a BPE pass over every kilobyte of
            // every request on the path out to the provider.
            body: text,
        };
        remember(snapshots, request.sessionID, snapshot, MAX_SNAPSHOTS);
        // Written through so the capture survives a server restart and survives
        // being evicted from the in-memory window.
        void persist(ctx.storage, request.sessionID, snapshot);
      } catch {
        // An unreadable body must not take the session down; the next request
        // overwrites the snapshot anyway.
      }
    });

    /**
     * Fallback capture from the prompt itself.
     *
     * Covers bodies that are not JSON. Kept separate from the body capture so a
     * parse failure degrades to this rather than to nothing, and it never
     * overwrites a body capture, which is strictly more faithful.
     */
    await ctx.session.hook("context", (context) => {
      try {
        if (snapshots.get(context.sessionID)?.fromBody) return;

        const system = (context.system ?? []).flatMap((part) => {
          const text = (part as { text?: unknown } | undefined)?.text;
          return typeof text === "string" ? [{ text }] : [];
        });
        const tools: Record<string, { description: string; input: unknown }> = {};
        for (const [name, definition] of Object.entries(context.tools ?? {})) {
          tools[name] = {
            description: typeof definition?.description === "string" ? definition.description : "",
            input: definition?.input,
          };
        }
        const messages = (context.messages ?? []).map((message) => {
          const record = (message ?? {}) as { role?: unknown; content?: unknown };
          return {
            role: typeof record.role === "string" ? record.role : "user",
            text: JSON.stringify(record.content ?? ""),
          };
        });

        const model = context.model as { providerID?: unknown; id?: unknown } | undefined;
        const providerID = typeof model?.providerID === "string" ? model.providerID : undefined;
        const modelID = typeof model?.id === "string" ? model.id : undefined;

        remember(
          snapshots,
          context.sessionID,
          {
            system,
            tools,
            mcpTools: {},
            mcpNamespaces: [],
            messages,
            ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
            capturedAt: Date.now(),
            fromBody: false,
          },
          MAX_SNAPSHOTS,
        );
      } catch {
        // A malformed payload must not take the session down with it.
      }
    });

    /** The newest provider reading of what one request occupied. */
    const reportedUsage = async (sessionID: string): Promise<number | undefined> => {
      try {
        const messages = await ctx.session.context({ sessionID });
        if (!Array.isArray(messages)) return undefined;
        // Walk backwards: the most recent assistant turn that reported usage is
        // the one that describes the window as it stands now.
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i] as { type?: unknown; tokens?: unknown };
          if (message?.type !== "assistant" || !message.tokens) continue;
          const tokens = message.tokens as { input?: unknown; cache?: { read?: unknown; write?: unknown } };
          const input = typeof tokens.input === "number" ? tokens.input : 0;
          const read = typeof tokens.cache?.read === "number" ? tokens.cache.read : 0;
          const write = typeof tokens.cache?.write === "number" ? tokens.cache.write : 0;
          // The input side only. Output tokens are what the model produced and
          // do not occupy the window it will read next.
          const total = input + read + write;
          if (total > 0) return total;
        }
      } catch {
        // A session that cannot be read still has a snapshot worth reporting.
      }
      return undefined;
    };

    /**
     * The model a session is on, preferring the captured one.
     *
     * A session that has run in this process carries its model on the capture.
     * One that has not — because it last ran before a restart, or its capture
     * was evicted — still records it on the session itself, so the window and
     * the gauge do not depend on having captured a prompt.
     */
    const resolveSessionModel = async (
      c: Context,
      sessionID: string,
      captured: { providerID: string; modelID: string } | undefined,
    ): Promise<{ providerID: string; modelID: string } | undefined> => {
      if (captured) return captured;
      try {
        const info = await c.session.get({ sessionID });
        const model = info?.model as { id?: unknown; providerID?: unknown } | undefined;
        if (typeof model?.id === "string" && typeof model?.providerID === "string") {
          return { providerID: model.providerID, modelID: model.id };
        }
      } catch {
        // A session the store cannot resolve simply has no model to report.
      }
      return undefined;
    };

    /** The window the model allows. */
    const resolveLimit = async (model: { providerID: string; modelID: string } | undefined): Promise<number> => {
      if (!model) return 0;
      try {
        const result = await ctx.model.list();
        const models = (result?.data ?? []) as { id?: string; providerID?: string; limit?: { context?: number } }[];
        const match = models.find((entry) => entry.id === model.modelID && entry.providerID === model.providerID);
        const limit = match?.limit?.context;
        if (typeof limit === "number" && limit > 0) return limit;
      } catch {
        // Fall through to the unknown-window case.
      }
      return 0;
    };

    /**
     * Headroom reserved for compaction, and where compaction fires.
     *
     * Mirrors OpenCode's own arithmetic, read out of the shipped build rather
     * than assumed: an explicit `compaction.buffer` wins, and otherwise the
     * reserve is the larger of 10% of the window and 16k tokens, with the 16k
     * floor applying only from a 32k window upwards.
     */
    const resolveCompaction = (context: number): { buffer: number; threshold: number } | undefined => {
      if (options.compactionBuffer !== undefined) {
        return { buffer: options.compactionBuffer, threshold: Math.max(0, context - options.compactionBuffer) };
      }
      if (context <= 0) return undefined;
      const reserve = Math.max(Math.floor(context * 0.1), context >= 32_000 ? 16_000 : 0);
      return { buffer: reserve, threshold: Math.max(0, context - reserve) };
    };

    const registration = await ctx.rpc.register(ContextRpc, {
      report: async (input) => {
        const sessionID = (input as { sessionID?: unknown } | undefined)?.sessionID;
        if (typeof sessionID !== "string" || sessionID === "") {
          return {
            generatedAt: Date.now(),
            used: 0,
            limit: 0,
            exact: false,
            tokenized: false,
            categories: {},
            memoryFiles: [],
            skills: [],
            tools: [],
            notes: ["No session selected"],
          } satisfies ContextReport;
        }

        await refreshMcpOwners();
        // In memory first, then the durable copy, so switching to a chat that
        // last ran before a restart still reports instead of coming up empty.
        let snapshot = snapshots.get(sessionID);
        // Reading counts as use, so the snapshot survives the eviction sweep.
        if (snapshot) remember(snapshots, sessionID, snapshot, MAX_SNAPSHOTS);
        let restored = false;
        if (!snapshot) {
          snapshot = await restore(sessionID);
          restored = snapshot !== undefined;
          if (snapshot) remember(snapshots, sessionID, snapshot, MAX_SNAPSHOTS);
        }

        const notes: string[] = [];
        const reported = await reportedUsage(sessionID);

        /**
         * The model, which does not depend on having captured a prompt.
         *
         * The session record carries it whether or not this process ever saw a
         * request for the session, so the window and the gauge are known even
         * when the prompt itself has not been measured.
         */
        const modelRef = await resolveSessionModel(ctx, sessionID, snapshot?.model);
        const limit = await resolveLimit(modelRef);
        const compaction = resolveCompaction(limit);
        const model = modelRef ? `${modelRef.providerID}/${modelRef.modelID}` : undefined;

        if (!snapshot) {
          notes.push("This session's prompt has not been captured, so only the provider's own reading is shown. Send a message to measure the breakdown.");
        } else if (restored) {
          notes.push("Restored from a previous run; the breakdown reflects the prompt as it was then.");
        } else if (!snapshot.fromBody) {
          notes.push("Read from the prompt rather than the request body, so figures may differ slightly from the provider's.");
        }
        if (limit === 0) notes.push("The context window for this model is unknown.");

        const respond = (measurement: Measurement | undefined): ContextReport => {
          const used = reported ?? measurement?.measuredTotal ?? 0;
          return {
            generatedAt: Date.now(),
            ...(model ? { model } : {}),
            used,
            limit,
            exact: reported !== undefined,
            tokenized: measurement?.tokenized ?? false,
            categories: measurement?.categories ?? {},
            memoryFiles: measurement?.memoryFiles.map((entry) => ({ name: entry.path, tokens: entry.tokens })) ?? [],
            skills: measurement?.skills.map((entry) => ({ name: entry.name || entry.id, tokens: entry.tokens })) ?? [],
            tools:
              measurement?.tools.map((entry) => ({
                name: entry.name,
                tokens: entry.tokens,
                ...(entry.mcp ? { mcp: true } : {}),
                ...(entry.server ? { server: entry.server } : {}),
              })) ?? [],
            ...(compaction ? { compactionBuffer: compaction.buffer, compactionThreshold: compaction.threshold } : {}),
            ...(measurement && measurement.unattributed > 0 ? { unattributed: measurement.unattributed } : {}),
            notes,
          } satisfies ContextReport;
        };

        if (!snapshot) return respond(undefined);

        const tokenizer = modelRef ? await resolveTokenizer(modelRef.providerID, modelRef.modelID) : undefined;

        // Counted here rather than at capture time: this runs only when someone
        // actually opens the dialog, and a failure costs one figure rather than
        // the whole measurement.
        let envelope: number | undefined;
        if (tokenizer && snapshot.body) {
          try {
            envelope = await tokenizer.count(snapshot.body);
          } catch {
            // Without it the framing line is simply omitted.
          }
        }

        const measurement = await measure({
          system: snapshot.system,
          tools: snapshot.tools,
          mcpTools: snapshot.mcpTools,
          // The namespaces known now are unioned with the ones recorded when
          // the capture was taken. Which servers exist is a property of the
          // environment rather than of the prompt, so a capture restored from
          // a previous run still gets attributed against the servers that are
          // configured today.
          mcpNamespaces: [...new Set([...(snapshot.mcpNamespaces ?? []), ...mcpNamespacesOwn])],
          messages: snapshot.messages,
          ...(tokenizer ? { tokenizer } : {}),
          ...(envelope !== undefined ? { envelope } : {}),
        });

        const reconciled = reconcile(measurement, reported);
        return {
          ...respond(reconciled),
          ...(tokenizer ? { tokenizer: tokenizer.name } : {}),
        };
      },
    });

    return () => registration.dispose();
  },
});

export default ContextPlugin;
