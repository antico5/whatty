import { describe, expect, it } from "vitest";
import {
  aggregateReactions,
  directionIndicator,
  formatBytes,
  formatListTimestamp,
  formatMessageTime,
  isToday,
  truncate,
} from "./format.js";
import { theme } from "../theme.js";

describe("aggregateReactions", () => {
  it("returns empty string for undefined reactions", () => {
    expect(aggregateReactions(undefined, 20)).toBe("");
  });

  it("returns empty string for an empty array", () => {
    expect(aggregateReactions([], 20)).toBe("");
  });

  it("renders a single reaction without a count", () => {
    expect(aggregateReactions([{ emoji: "👍", sender: "a" }], 20)).toBe("👍");
  });

  it("renders a reaction with count when multiple senders use the same emoji", () => {
    const reactions = [
      { emoji: "👍", sender: "a" },
      { emoji: "👍", sender: "b" },
    ];
    expect(aggregateReactions(reactions, 20)).toBe("👍2");
  });

  it("renders multiple distinct emoji separated by spaces", () => {
    const reactions = [
      { emoji: "👍", sender: "a" },
      { emoji: "❤️", sender: "b" },
    ];
    expect(aggregateReactions(reactions, 20)).toBe("👍 ❤️");
  });

  it("deduplicates by sender — last reaction per sender wins", () => {
    const reactions = [
      { emoji: "👍", sender: "a" },
      { emoji: "❤️", sender: "a" }, // replaces the 👍
    ];
    // Only ❤️ remains for sender "a"
    expect(aggregateReactions(reactions, 20)).toBe("❤️");
  });

  it("removes a sender's reaction when emoji is empty (retraction)", () => {
    const reactions = [
      { emoji: "👍", sender: "a" },
      { emoji: "", sender: "a" }, // retraction
    ];
    expect(aggregateReactions(reactions, 20)).toBe("");
  });

  it("retraction by one sender leaves other senders' reactions intact", () => {
    const reactions = [
      { emoji: "👍", sender: "a" },
      { emoji: "👍", sender: "b" },
      { emoji: "", sender: "a" }, // a retracts
    ];
    // Only b's 👍 remains
    expect(aggregateReactions(reactions, 20)).toBe("👍");
  });

  it("truncates with … when segments exceed maxColumns", () => {
    // Each emoji costs 2 cols, space costs 1, so 3 emoji = 2+1+2+1+2 = 8 cols
    // With maxColumns=4, only the first emoji (2 cols) fits; adding … (1 col after space = 2 total)
    // brings us to 4 cols exactly.
    const reactions = [
      { emoji: "👍", sender: "a" },
      { emoji: "❤️", sender: "b" },
      { emoji: "😂", sender: "c" },
    ];
    const result = aggregateReactions(reactions, 4);
    // "👍 …" = 2 + 1 + 1 = 4 cols
    expect(result).toBe("👍 …");
  });

  it("counts do not cause truncation when they fit", () => {
    // "👍3" = 2 (emoji) + 1 (digit) = 3 cols — fits in maxColumns=5
    const reactions = [
      { emoji: "👍", sender: "a" },
      { emoji: "👍", sender: "b" },
      { emoji: "👍", sender: "c" },
    ];
    expect(aggregateReactions(reactions, 5)).toBe("👍3");
  });
});

describe("isToday", () => {
  it("returns true for the same calendar date", () => {
    const now = new Date(2024, 5, 15, 14, 30); // 2024-06-15 14:30
    const date = new Date(2024, 5, 15, 9, 0); // same day, different time
    expect(isToday(date, now)).toBe(true);
  });

  it("returns false for a different date", () => {
    const now = new Date(2024, 5, 15, 14, 30);
    const date = new Date(2024, 5, 14, 23, 59); // one day before
    expect(isToday(date, now)).toBe(false);
  });

  it("returns false at midnight boundary — 23:59 today vs 00:00 tomorrow", () => {
    const now = new Date(2024, 5, 16, 0, 0); // midnight of the 16th
    const date = new Date(2024, 5, 15, 23, 59); // one minute before, still the 15th
    expect(isToday(date, now)).toBe(false);
  });

  it("returns true for a message at 00:00 on the same day", () => {
    const now = new Date(2024, 5, 15, 23, 59);
    const date = new Date(2024, 5, 15, 0, 0);
    expect(isToday(date, now)).toBe(true);
  });

  it("handles year rollover — Dec 31 vs Jan 1", () => {
    const now = new Date(2025, 0, 1, 0, 0); // 2025-01-01
    const date = new Date(2024, 11, 31, 23, 59); // 2024-12-31
    expect(isToday(date, now)).toBe(false);
  });
});

describe("formatListTimestamp", () => {
  it("formats today's timestamps as HH:MM", () => {
    const now = new Date(2024, 5, 15, 14, 30);
    const ts = new Date(2024, 5, 15, 9, 5).getTime();
    expect(formatListTimestamp(ts, now)).toBe("09:05");
  });

  it("formats older timestamps as yyyy-mm-dd HH:MM", () => {
    const now = new Date(2024, 5, 15, 14, 30);
    const ts = new Date(2023, 0, 2, 23, 59).getTime();
    expect(formatListTimestamp(ts, now)).toBe("2023-01-02 23:59");
  });

  it("boundary: 23:59 yesterday is not today", () => {
    const now = new Date(2024, 5, 15, 0, 0); // midnight of the 15th
    const ts = new Date(2024, 5, 14, 23, 59).getTime(); // 23:59 on the 14th
    expect(formatListTimestamp(ts, now)).toBe("2024-06-14 23:59");
  });

  it("boundary: 00:00 today is today", () => {
    const now = new Date(2024, 5, 15, 23, 59);
    const ts = new Date(2024, 5, 15, 0, 0).getTime();
    expect(formatListTimestamp(ts, now)).toBe("00:00");
  });

  it("year rollover: Dec 31 formats with date when now is Jan 1", () => {
    const now = new Date(2025, 0, 1, 0, 5);
    const ts = new Date(2024, 11, 31, 23, 59).getTime();
    expect(formatListTimestamp(ts, now)).toBe("2024-12-31 23:59");
  });

  it("pads single-digit months and days", () => {
    const now = new Date(2025, 5, 15, 12, 0);
    const ts = new Date(2024, 0, 2, 8, 3).getTime(); // 2024-01-02 08:03
    expect(formatListTimestamp(ts, now)).toBe("2024-01-02 08:03");
  });
});

describe("formatMessageTime", () => {
  it("formats today's messages as HH:MM", () => {
    const now = new Date(2024, 5, 15, 14, 30);
    const ts = new Date(2024, 5, 15, 9, 5).getTime();
    expect(formatMessageTime(ts, now)).toBe("09:05");
  });

  it("formats older messages as yyyy-mm-dd HH:MM", () => {
    const now = new Date(2024, 5, 15, 14, 30);
    const ts = new Date(2023, 0, 2, 23, 59).getTime();
    expect(formatMessageTime(ts, now)).toBe("2023-01-02 23:59");
  });

  it("boundary: 23:59 yesterday is not today", () => {
    const now = new Date(2024, 5, 15, 0, 0); // midnight of the 15th
    const ts = new Date(2024, 5, 14, 23, 59).getTime();
    expect(formatMessageTime(ts, now)).toBe("2024-06-14 23:59");
  });

  it("boundary: 00:00 today is today", () => {
    const now = new Date(2024, 5, 15, 23, 59);
    const ts = new Date(2024, 5, 15, 0, 0).getTime();
    expect(formatMessageTime(ts, now)).toBe("00:00");
  });

  it("year rollover: Dec 31 formats with date when now is Jan 1", () => {
    const now = new Date(2025, 0, 1, 0, 5);
    const ts = new Date(2024, 11, 31, 23, 59).getTime();
    expect(formatMessageTime(ts, now)).toBe("2024-12-31 23:59");
  });

  it("pads single-digit months and days", () => {
    const now = new Date(2025, 5, 15, 12, 0);
    const ts = new Date(2024, 0, 2, 8, 3).getTime(); // 2024-01-02 08:03
    expect(formatMessageTime(ts, now)).toBe("2024-01-02 08:03");
  });
});

describe("truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("collapses internal whitespace to single spaces", () => {
    expect(truncate("hello\n  world", 20)).toBe("hello world");
  });

  it("cuts long text and appends an ellipsis", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
  });

  it("handles a width of one", () => {
    expect(truncate("hello", 1)).toBe("…");
  });
});

describe("directionIndicator", () => {
  it("returns a green right arrow for outbound", () => {
    expect(directionIndicator("outbound")).toEqual({ symbol: "→", style: theme.outbound });
  });

  it("returns a default-fg left arrow for inbound", () => {
    expect(directionIndicator("inbound")).toEqual({ symbol: "←", style: theme.inbound });
  });
});

describe("formatBytes", () => {
  it("renders bytes without a decimal for the B unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("renders kilobytes with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10.0 KB");
  });

  it("renders megabytes with one decimal", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(12_400_000)).toBe("11.8 MB");
  });

  it("renders gigabytes with one decimal", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  it("clamps negative values to 0 B", () => {
    expect(formatBytes(-100)).toBe("0 B");
  });
});
