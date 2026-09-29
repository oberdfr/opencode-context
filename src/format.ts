/**
 * Presentation helpers.
 *
 * Pure formatting, kept out of the TUI component so the exact strings the
 * dialog renders can be asserted in tests.
 */

import { bold, StyledText } from "@opentui/core";

/** Bar glyphs, heaviest to lightest, for the overall window gauge. */
const FILLED = "█";
const PARTIAL = "▓";
const EMPTY = "░";
/** Marks the token at which OpenCode will compact. */
const MARK = "┃";

/** Width of the overall gauge, in cells. */
export const BAR_WIDTH = 24;

/**
 * Bold text for use as a `text` child.
 *
 * `TextNodeRenderable.add` accepts a string, another renderable, or a
 * `StyledText`, and throws on anything else. The `bold` helper on its own returns
 * a bare chunk, which is none of those, so the chunk is wrapped in a
 * `StyledText`: the styled value the renderable actually expects.
 *
 * The return type is widened only so the published child type accepts it. The
 * value really is a `StyledText` at runtime.
 */
export function strong(value: string): string {
  return new StyledText([bold(value)]) as unknown as string;
}

/**
 * A filled/empty bar for a fraction between 0 and 1.
 */
export function bar(fraction: number, width: number = BAR_WIDTH): string {
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const exact = clamped * Math.max(0, width);
  const full = Math.floor(exact);
  // Past halfway the half-cell mark is what stops a 90%-full bar from reading
  // as empty next to a 95% one.
  const partial = exact - full >= 0.5 && full < width;
  const used = full + (partial ? 1 : 0);
  return FILLED.repeat(full) + (partial ? PARTIAL : "") + EMPTY.repeat(Math.max(0, width - used));
}

/**
 * The window gauge, with a marker where compaction will trigger.
 *
 * The marker is drawn over the bar rather than as a separate line so the
 * threshold is read against the same scale as the fill: everything to the right
 * of the mark is the reserve OpenCode keeps free, and the run of `=` beneath it
 * spells out how large that reserve is.
 */
export function windowBar(options: {
  used: number;
  limit: number;
  /** Context usage at which compaction triggers, when known. */
  threshold?: number;
  width?: number;
}): string {
  const { used, limit, threshold, width = BAR_WIDTH } = options;
  if (limit <= 0) return bar(0, width);

  const cells = Math.max(0, width);
  // The fill is clamped so a reading past the window cannot run off the track,
  // but the threshold is not: it is a real position on the same scale.
  const fillFraction = Math.min(1, Math.max(0, used / limit));
  const filled = fillFraction * cells;
  const full = Math.floor(filled);
  const partial = filled - full >= 0.5 && full < cells;
  const usedCells = full + (partial ? 1 : 0);

  // The marker is placed on its own cell so it is never half-hidden by the
  // fill; rounding down puts it at or before the true threshold.
  const markerIndex =
    threshold !== undefined && threshold > 0 && threshold < limit ? Math.floor((threshold / limit) * cells) : -1;

  const glyphs: string[] = [];
  for (let i = 0; i < cells; i++) {
    if (i === markerIndex) glyphs.push(MARK);
    else if (i < usedCells) glyphs.push(FILLED);
    else glyphs.push(EMPTY);
  }
  return glyphs.join("");
}

/**
 * Compact token counts.
 *
 * The decimal cutoff sits at 100k rather than 10k: below it a decimal is what
 * distinguishes "21.1k" from "21k" at a glance, and above it the thousands
 * digit is noise next to the window size being compared against.
 */
export function formatTokens(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A percentage with no decimals, which is all the resolution a bar can show. */
export function formatPercent(fraction: number): string {
  const pct = Number.isFinite(fraction) ? fraction * 100 : 0;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/** `21.1k/190k` — used, over the window. */
export function formatUsage(used: number, limit: number): string {
  if (limit <= 0) return formatTokens(used);
  return `${formatTokens(used)}/${formatTokens(limit)}`;
}

/**
 * How full the window is, as a fraction.
 */
export function fillFraction(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(1, Math.max(0, used / limit));
}

/**
 * Severity of a fill level, for colour.
 *
 * The thresholds are relative to where compaction actually fires rather than
 * fixed: amber is the run-up to the configured trigger, red is past it. A
 * session close to compaction should not look calm because the window happens
 * to be large.
 */
export type Tone = "ok" | "warn" | "critical";

export function fillTone(used: number, limit: number, threshold?: number): Tone {
  if (limit <= 0) return "ok";
  const fraction = used / limit;

  // With a known trigger the bands are relative to it: amber is the run-up to
  // compaction and red is past it. A session close to compaction should not
  // look calm just because its window happens to be large.
  if (threshold !== undefined && threshold > 0 && threshold < limit) {
    if (used >= threshold) return "critical";
    if (used >= threshold * 0.8) return "warn";
    return "ok";
  }

  // Without one there is no trigger to be relative to, so fall back to fixed
  // bands on the window itself.
  if (fraction >= 0.85) return "critical";
  if (fraction >= 0.6) return "warn";
  return "ok";
}

/**
 * Shortens a long path for a fixed column, keeping the filename.
 *
 * The leading directories are the part a reader can drop; the tail is what
 * identifies the file.
 */
export function formatPath(path: string, max: number): string {
  if (path.length <= max) return path;
  if (max <= 3) return path.slice(-max);
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  // If the filename alone fills the column, elide its middle instead.
  if (name.length >= max - 1) return `…${name.slice(-(max - 1))}`;
  const head = `${parts.filter(Boolean).slice(-1)[0] ?? ""}/`;
  const room = max - head.length - 1;
  return room <= 0 ? `…/${name}` : `…${head}${name.length > room ? name.slice(-room) : name}`;
}
