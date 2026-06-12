import { describe, expect, it } from "vitest";
import { supportsHyperlinks } from "./termCaps.js";

describe("supportsHyperlinks", () => {
  it("returns false for empty env", () => {
    expect(supportsHyperlinks({})).toBe(false);
  });

  it("WA_CHAT_HYPERLINKS=1 forces on regardless of other vars", () => {
    expect(supportsHyperlinks({ WA_CHAT_HYPERLINKS: "1" })).toBe(true);
    expect(supportsHyperlinks({ WA_CHAT_HYPERLINKS: "1", TERM_PROGRAM: "unknown" })).toBe(true);
  });

  it("WA_CHAT_HYPERLINKS=0 forces off regardless of other vars", () => {
    expect(supportsHyperlinks({ WA_CHAT_HYPERLINKS: "0" })).toBe(false);
    expect(supportsHyperlinks({ WA_CHAT_HYPERLINKS: "0", TERM_PROGRAM: "iTerm.app" })).toBe(false);
  });

  it.each([
    "iTerm.app",
    "WezTerm",
    "ghostty",
    "vscode",
    "Hyper",
    "kitty",
  ])("TERM_PROGRAM=%s → true", (termProgram) => {
    expect(supportsHyperlinks({ TERM_PROGRAM: termProgram })).toBe(true);
  });

  it("TERM_PROGRAM=xterm → false (unknown)", () => {
    expect(supportsHyperlinks({ TERM_PROGRAM: "xterm" })).toBe(false);
  });

  it("VTE_VERSION >= 5000 → true", () => {
    expect(supportsHyperlinks({ VTE_VERSION: "5000" })).toBe(true);
    expect(supportsHyperlinks({ VTE_VERSION: "6602" })).toBe(true);
  });

  it("VTE_VERSION < 5000 → false", () => {
    expect(supportsHyperlinks({ VTE_VERSION: "4999" })).toBe(false);
  });

  it("KONSOLE_VERSION present → true", () => {
    expect(supportsHyperlinks({ KONSOLE_VERSION: "220401" })).toBe(true);
  });

  it("WT_SESSION present → true (Windows Terminal)", () => {
    expect(supportsHyperlinks({ WT_SESSION: "some-guid" })).toBe(true);
  });

  it("ALACRITTY_SOCKET present → true", () => {
    expect(supportsHyperlinks({ ALACRITTY_SOCKET: "/tmp/alacritty.sock" })).toBe(true);
  });

  it("ALACRITTY_LOG present → true", () => {
    expect(supportsHyperlinks({ ALACRITTY_LOG: "/tmp/alacritty.log" })).toBe(true);
  });
});
