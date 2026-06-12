import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDataDir } from "./migrate.js";

// We control defaultDataDir by setting WHATSAPP_TERMINAL_DATA_DIR, BUT the
// migration logic explicitly skips when that env var is set.  Instead we mock
// defaultDataDir so that tests can point both the legacy dir and the new dir
// at arbitrary temp locations without touching the real filesystem.
vi.mock("./paths.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./paths.js")>();
  return {
    ...original,
    defaultDataDir: vi.fn(() => "/placeholder"),
  };
});

import { defaultDataDir } from "./paths.js";

let tmpDir: string;
let savedEnvOverride: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-terminal-migrate-"));
  savedEnvOverride = process.env.WHATSAPP_TERMINAL_DATA_DIR;
  delete process.env.WHATSAPP_TERMINAL_DATA_DIR;
});

afterEach(async () => {
  vi.mocked(defaultDataDir).mockReset();
  if (savedEnvOverride === undefined) delete process.env.WHATSAPP_TERMINAL_DATA_DIR;
  else process.env.WHATSAPP_TERMINAL_DATA_DIR = savedEnvOverride;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Create a minimal fake data layout under `dir`. */
async function seedDataDir(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "accounts", "5491100000000@s.whatsapp.net"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "accounts", "5491100000000@s.whatsapp.net", "chats.db"),
    "fake-sqlite-data",
    "utf8",
  );
  await fs.writeFile(path.join(dir, "whatsapp-terminal.log"), "log line\n", "utf8");
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}

describe("migrateDataDir", () => {
  it("skips migration when WHATSAPP_TERMINAL_DATA_DIR env var is set", async () => {
    const legacyDir = path.join(tmpDir, "legacy");
    const newDir = path.join(tmpDir, "new");
    process.env.WHATSAPP_TERMINAL_DATA_DIR = "/some/override";
    vi.mocked(defaultDataDir).mockReturnValue(newDir);

    await seedDataDir(legacyDir);
    // Fake cwd that has a ./data subdir == legacyDir
    const cwd = tmpDir; // tmpDir/data = legacyDir if we name it "data"
    const dataLegacy = path.join(tmpDir, "data");
    await seedDataDir(dataLegacy);

    await migrateDataDir(tmpDir);

    // Legacy dir must remain untouched; new dir must not have been created
    expect(await exists(dataLegacy)).toBe(true);
    expect(await exists(newDir)).toBe(false);
  });

  it("moves old ./data to the new location when only legacy dir exists", async () => {
    const newDir = path.join(tmpDir, "new-data-home");
    vi.mocked(defaultDataDir).mockReturnValue(newDir);

    const legacyDir = path.join(tmpDir, "data");
    await seedDataDir(legacyDir);

    await migrateDataDir(tmpDir);

    // Legacy dir is gone; new dir exists with the same content
    expect(await exists(legacyDir)).toBe(false);
    expect(await exists(newDir)).toBe(true);
    expect(await exists(path.join(newDir, "accounts", "5491100000000@s.whatsapp.net", "chats.db"))).toBe(true);
    expect(await exists(path.join(newDir, "whatsapp-terminal.log"))).toBe(true);
  });

  it("is idempotent: second call does nothing when only new dir exists", async () => {
    const newDir = path.join(tmpDir, "new-data-home");
    vi.mocked(defaultDataDir).mockReturnValue(newDir);

    const legacyDir = path.join(tmpDir, "data");
    await seedDataDir(legacyDir);

    // First migration
    await migrateDataDir(tmpDir);
    expect(await exists(legacyDir)).toBe(false);
    expect(await exists(newDir)).toBe(true);

    // Second call: legacy is gone, nothing moves
    await migrateDataDir(tmpDir);
    expect(await exists(newDir)).toBe(true);
  });

  it("does nothing when neither legacy nor new dir exists", async () => {
    const newDir = path.join(tmpDir, "new-data-home");
    vi.mocked(defaultDataDir).mockReturnValue(newDir);

    // No legacy dir created
    await migrateDataDir(tmpDir);

    expect(await exists(newDir)).toBe(false);
  });

  it("warns and keeps both dirs untouched when both exist", async () => {
    const newDir = path.join(tmpDir, "new-data-home");
    vi.mocked(defaultDataDir).mockReturnValue(newDir);

    const legacyDir = path.join(tmpDir, "data");
    await seedDataDir(legacyDir);
    await seedDataDir(newDir);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await migrateDataDir(tmpDir);

    // Both dirs survive untouched
    expect(await exists(legacyDir)).toBe(true);
    expect(await exists(newDir)).toBe(true);
    expect(await exists(path.join(legacyDir, "whatsapp-terminal.log"))).toBe(true);
    expect(await exists(path.join(newDir, "whatsapp-terminal.log"))).toBe(true);

    // User was warned
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg: string = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain(legacyDir);
    expect(msg).toContain(newDir);

    warnSpy.mockRestore();
  });
});
