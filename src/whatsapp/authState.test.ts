import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAccountDb, type AccountDb } from "../persistence/db.js";
import { setActiveAccount } from "../persistence/paths.js";
import { makeDbAuthState, readCredsMeFromDb, wipeAuth } from "./authState.js";

const ACCOUNT_ID = "5491100000000@s.whatsapp.net";

let tmpDir: string;
let originalDataDir: string | undefined;
let db: AccountDb;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-terminal-auth-"));
  originalDataDir = process.env.WHATSAPP_TERMINAL_DATA_DIR;
  process.env.WHATSAPP_TERMINAL_DATA_DIR = tmpDir;
  db = await openAccountDb(ACCOUNT_ID);
});

afterEach(async () => {
  db.close();
  if (originalDataDir === undefined) delete process.env.WHATSAPP_TERMINAL_DATA_DIR;
  else process.env.WHATSAPP_TERMINAL_DATA_DIR = originalDataDir;
  setActiveAccount(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("makeDbAuthState", () => {
  it("initializes fresh creds and persists them across reopen via saveCreds", async () => {
    const auth = makeDbAuthState(db);
    expect(auth.state.creds.registrationId).toBeGreaterThan(0);

    (auth.state.creds as { me?: { id: string; name: string } }).me = {
      id: "5491100000000:7@s.whatsapp.net",
      name: "Main",
    };
    await auth.saveCreds();

    db.close();
    db = await openAccountDb(ACCOUNT_ID);
    const reopened = makeDbAuthState(db);
    expect(reopened.state.creds.me?.name).toBe("Main");
    expect(readCredsMeFromDb(db)).toEqual({ id: "5491100000000:7@s.whatsapp.net", name: "Main" });
  });

  it("round-trips signal keys with binary payloads, including ids with ':' and deletion", async () => {
    const auth = makeDbAuthState(db);
    const session = { secret: new Uint8Array([1, 2, 3, 255]) };

    await auth.state.keys.set({
      session: { "5491100000001.0": session, "5491100000001:55.0": session },
    } as never);

    const got = (await auth.state.keys.get("session", [
      "5491100000001.0",
      "5491100000001:55.0",
      "ghost",
    ])) as unknown as Record<string, { secret: Uint8Array }>;
    expect(Object.keys(got).sort()).toEqual(["5491100000001.0", "5491100000001:55.0"]);
    expect(Buffer.from(got["5491100000001.0"]!.secret)).toEqual(Buffer.from([1, 2, 3, 255]));

    await auth.state.keys.set({ session: { "5491100000001.0": null } } as never);
    const after = await auth.state.keys.get("session", ["5491100000001.0"]);
    expect(Object.keys(after)).toEqual([]);
  });

  it("wipeAuth removes creds (the account 'unlink') without touching other tables", async () => {
    const auth = makeDbAuthState(db);
    (auth.state.creds as { me?: { id: string } }).me = { id: "5491100000000@s.whatsapp.net" };
    await auth.saveCreds();
    db.sql.prepare("INSERT INTO chats (jid, type) VALUES (?, ?)").run("x@s.whatsapp.net", "individual");

    wipeAuth(db);

    expect(readCredsMeFromDb(db)).toBeNull();
    expect(db.sql.prepare("SELECT COUNT(*) AS n FROM chats").get()).toEqual({ n: 1 });
  });
});
