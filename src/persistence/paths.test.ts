import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDataDir } from "./paths.js";

/** Save and restore all env vars + process.platform between tests. */
let savedPlatform: NodeJS.Platform;
let savedHome: string | undefined;
let savedXdgDataHome: string | undefined;
let savedLocalAppData: string | undefined;

beforeEach(() => {
  savedPlatform = process.platform;
  savedHome = process.env.HOME;
  savedXdgDataHome = process.env.XDG_DATA_HOME;
  savedLocalAppData = process.env.LOCALAPPDATA;
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdgDataHome;
  if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = savedLocalAppData;
});

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

describe("defaultDataDir", () => {
  describe("Linux (default XDG)", () => {
    it("uses ~/.local/share/whatsapp-terminal when XDG_DATA_HOME is not set", () => {
      setPlatform("linux");
      delete process.env.XDG_DATA_HOME;
      const home = os.homedir();
      expect(defaultDataDir()).toBe(path.join(home, ".local", "share", "whatsapp-terminal"));
    });

    it("uses $XDG_DATA_HOME/whatsapp-terminal when XDG_DATA_HOME is set", () => {
      setPlatform("linux");
      process.env.XDG_DATA_HOME = "/custom/xdg";
      expect(defaultDataDir()).toBe("/custom/xdg/whatsapp-terminal");
    });
  });

  describe("macOS", () => {
    it("uses ~/Library/Application Support/whatsapp-terminal", () => {
      setPlatform("darwin");
      const home = os.homedir();
      expect(defaultDataDir()).toBe(path.join(home, "Library", "Application Support", "whatsapp-terminal"));
    });
  });

  describe("Windows", () => {
    it("uses %LOCALAPPDATA%/whatsapp-terminal/Data when LOCALAPPDATA is set", () => {
      setPlatform("win32");
      // Use a Unix-style path so path.join produces a consistent result on the
      // host running the tests (which is Linux in CI).
      const localAppData = "/Users/Test/AppData/Local";
      process.env.LOCALAPPDATA = localAppData;
      expect(defaultDataDir()).toBe(path.join(localAppData, "whatsapp-terminal", "Data"));
    });

    it("falls back to ~/AppData/Local/whatsapp-terminal/Data when LOCALAPPDATA is not set", () => {
      setPlatform("win32");
      delete process.env.LOCALAPPDATA;
      const home = os.homedir();
      expect(defaultDataDir()).toBe(path.join(home, "AppData", "Local", "whatsapp-terminal", "Data"));
    });
  });
});
