import { describe, expect, it } from "vitest";
import { directionIndicator, formatListTimestamp, truncate } from "./format.js";
import { theme } from "../theme.js";

describe("formatListTimestamp", () => {
  it("formats today's timestamps as HH:MM", () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).getTime();
    expect(formatListTimestamp(today)).toBe("09:05");
  });

  it("formats older timestamps as yyyy-mm-dd", () => {
    const past = new Date(2023, 0, 2, 23, 59).getTime();
    expect(formatListTimestamp(past)).toBe("2023-01-02");
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
