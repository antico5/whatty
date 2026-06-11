import fs from "node:fs/promises";
import { getLogger } from "../logger.js";
import type { Chat } from "../types/index.js";
import { chatFile, chatsRootDir, chatDir, mediaDir } from "./paths.js";

export async function ensureChatDir(jid: string): Promise<void> {
  await fs.mkdir(chatDir(jid), { recursive: true });
  await fs.mkdir(mediaDir(jid), { recursive: true });
}

export async function loadChat(jid: string): Promise<Chat | null> {
  const file = chatFile(jid);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  try {
    return JSON.parse(raw) as Chat;
  } catch (err) {
    const backup = `${file}.bak-${Date.now()}`;
    getLogger().warn({ err, file, backup }, "corrupt chats.json; backing up and discarding");
    await fs.rename(file, backup);
    return null;
  }
}

export async function saveChat(chat: Chat): Promise<void> {
  await ensureChatDir(chat.jid);
  const file = chatFile(chat.jid);
  const tmp = `${file}.tmp`;
  const json = JSON.stringify(chat, null, 2);
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, file);
}

export async function listChatJids(): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(chatsRootDir(), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

export async function loadAllChats(): Promise<Chat[]> {
  const jids = await listChatJids();
  const chats = await Promise.all(jids.map((jid) => loadChat(jid)));
  return chats.filter((c): c is Chat => c !== null);
}
