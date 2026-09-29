import { describe, expect, it } from "vitest";
import { bar, fillFraction, fillTone, formatPath, formatPercent, formatTokens, formatUsage, windowBar, BAR_WIDTH } from "./format.ts";

describe("bar", () => {
  it("is empty at zero and full at one", () => {
    expect(bar(0, 10)).toBe("░".repeat(10));
    expect(bar(1, 10)).toBe("█".repeat(10));
  });

  it("always occupies exactly the requested width", () => {
    for (const fraction of [0, 0.13, 0.5, 0.77, 0.99, 1]) {
      expect([...bar(fraction, 20)]).toHaveLength(20);
    }
  });

  it("marks the halfway cell so near-full bars stay distinguishable", () => {
    expect(bar(0.5, 10)).toBe("█████░░░░░");
    expect(bar(0.55, 10)).toBe("█████▓░░░░");
  });

  it("clamps out-of-range fractions", () => {
    expect(bar(-1, 5)).toBe("░░░░░");
    expect(bar(2, 5)).toBe("█████");
    expect(bar(Number.NaN, 5)).toBe("░░░░░");
  });

  it("survives a zero width", () => {
    expect(bar(0.5, 0)).toBe("");
  });
});

describe("formatTokens", () => {
  it("leaves small numbers alone", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("uses one decimal below a hundred thousand", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(21_100)).toBe("21.1k");
    expect(formatTokens(99_900)).toBe("99.9k");
  });

  it("rounds to whole thousands above that", () => {
    expect(formatTokens(190_000)).toBe("190k");
  });

  it("switches to millions for very large windows", () => {
    expect(formatTokens(1_048_576)).toBe("1.0M");
  });

  it("survives bad input", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });
});

describe("formatPercent", () => {
  it("rounds to whole numbers", () => {
    expect(formatPercent(0.11)).toBe("11%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("never claims zero for a non-zero share", () => {
    expect(formatPercent(0.004)).toBe("<1%");
  });
});

describe("formatUsage", () => {
  it("shows used over limit", () => {
    expect(formatUsage(21_100, 190_000)).toBe("21.1k/190k");
  });

  it("shows the used value alone when the window is unknown", () => {
    expect(formatUsage(500, 0)).toBe("500");
  });
});

describe("fillFraction and fillTone", () => {
  it("clamps a reading past the window to a full bar", () => {
    expect(fillFraction(200, 100)).toBe(1);
    expect(fillFraction(-5, 100)).toBe(0);
  });

  it("reports zero when the window is unknown", () => {
    expect(fillFraction(500, 0)).toBe(0);
  });

  it("escalates the tone as the window fills", () => {
    expect(fillTone(10, 100)).toBe("ok");
    expect(fillTone(60, 100)).toBe("warn");
    expect(fillTone(90, 100)).toBe("critical");
  });
});

describe("formatPath", () => {
  it("leaves a short path alone", () => {
    expect(formatPath("/tmp/AGENTS.md", 20)).toBe("/tmp/AGENTS.md");
  });

  it("keeps the tail of a long path", () => {
    const result = formatPath("/home/user/projects/thing/AGENTS.md", 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain("AGENTS.md");
    expect(result.startsWith("…")).toBe(true);
  });

  it("elides the middle when the filename alone fills the column", () => {
    const result = formatPath("/a/b/some-extremely-long-filename.md", 12);
    expect([...result]).toHaveLength(12);
    expect(result).toContain("…");
  });

  it("does not overflow an impossible width", () => {
    expect([...formatPath("/home/user/AGENTS.md", 3)]).toHaveLength(3);
  });
});

describe("windowBar", () => {
  it("is empty when the window is unknown", () => {
    expect(windowBar({ used: 100, limit: 0, width: 10 })).toBe("░".repeat(10));
  });

  it("is empty at zero and full at one", () => {
    expect(windowBar({ used: 0, limit: 100, width: 10 })).toBe("░".repeat(10));
    expect(windowBar({ used: 100, limit: 100, width: 10 })).toBe("█".repeat(10));
  });

  it("always occupies exactly the requested width", () => {
    for (const used of [0, 1, 50, 99, 100, 500]) {
      expect([...windowBar({ used, limit: 100, width: 24, threshold: 80 })]).toHaveLength(24);
    }
  });

  it("marks the compaction threshold on the bar", () => {
    // 80% of a 10-cell bar is cell 8, so the mark lands there.
    const rendered = windowBar({ used: 0, limit: 100, width: 10, threshold: 80 });
    expect(rendered).toBe("░░░░░░░░┃░");
  });

  it("keeps the mark visible when the fill has passed it", () => {
    const rendered = windowBar({ used: 95, limit: 100, width: 10, threshold: 80 });
    expect(rendered).toContain("┃");
    expect(rendered).not.toBe("█".repeat(10));
  });

  it("omits the mark when no threshold is given", () => {
    expect(windowBar({ used: 50, limit: 100, width: 10 })).not.toContain("┃");
  });

  it("omits a threshold that falls outside the window", () => {
    expect(windowBar({ used: 10, limit: 100, width: 10, threshold: 500 })).not.toContain("┃");
    expect(windowBar({ used: 10, limit: 100, width: 10, threshold: 0 })).not.toContain("┃");
  });

  it("survives a zero width", () => {
    expect(windowBar({ used: 50, limit: 100, width: 0, threshold: 80 })).toBe("");
  });

  it("defaults to the shared bar width", () => {
    expect([...windowBar({ used: 50, limit: 100, threshold: 80 })]).toHaveLength(BAR_WIDTH);
  });
});

describe("fillTone with a compaction threshold", () => {
  it("goes critical only once the trigger is reached", () => {
    // A large window at 50% is nowhere near a trigger at 90%.
    expect(fillTone(500, 1000, 900)).toBe("ok");
    expect(fillTone(750, 1000, 900)).toBe("warn");
    expect(fillTone(900, 1000, 900)).toBe("critical");
  });

  it("falls back to fixed bands when the trigger is unknown", () => {
    expect(fillTone(500, 1000)).toBe("ok");
    expect(fillTone(700, 1000)).toBe("warn");
    expect(fillTone(900, 1000)).toBe("critical");
  });

  it("ignores a threshold that is not inside the window", () => {
    expect(fillTone(700, 1000, 5000)).toBe("warn");
    expect(fillTone(700, 1000, 0)).toBe("warn");
  });
});
