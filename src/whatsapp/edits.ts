import { createDecipheriv, createHmac } from "node:crypto";
import { jidNormalizedUser, proto, type WAMessage } from "baileys";
import type { Message } from "../types/index.js";
import { rawWAMessage } from "./mappers.js";

interface EncryptedEdit {
  targetId: string;
  payload: Uint8Array;
  iv: Uint8Array;
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return Buffer.from(value, "base64");
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return Uint8Array.from((value as { data: number[] }).data);
  }
  return null;
}

export function encryptedEditOf(waMsg: WAMessage): EncryptedEdit | null {
  const encrypted = waMsg.message?.secretEncryptedMessage;
  if (!encrypted) return null;
  const isMessageEdit =
    encrypted.secretEncType === proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT ||
    (encrypted.secretEncType as unknown) === "MESSAGE_EDIT";
  if (!isMessageEdit || !encrypted.targetMessageKey?.id) {
    return null;
  }

  const payload = bytesOf(encrypted.encPayload);
  const iv = bytesOf(encrypted.encIv);
  if (!payload || !iv) return null;
  return { targetId: encrypted.targetMessageKey.id, payload, iv };
}

export function isPersistedEditEnvelope(message: Message): boolean {
  const raw = rawWAMessage(message);
  return Boolean(raw && encryptedEditOf(raw));
}

function messageSecretOf(message: Message): Uint8Array | null {
  return bytesOf(rawWAMessage(message)?.message?.messageContextInfo?.messageSecret);
}

function hmac(data: Uint8Array, key: Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function decryptEncryptedEdit(
  encrypted: EncryptedEdit,
  original: Message,
  originalSenderJid: string,
  editorJid: string,
): string | null {
  const secret = messageSecretOf(original);
  if (!secret || encrypted.iv.length !== 12 || encrypted.payload.length <= 16) return null;

  const info = Buffer.concat([
    Buffer.from(encrypted.targetId),
    Buffer.from(jidNormalizedUser(originalSenderJid)),
    Buffer.from(jidNormalizedUser(editorJid)),
    Buffer.from("Message Edit"),
    Buffer.from([1]),
  ]);
  const key = hmac(info, hmac(secret, new Uint8Array(32)));
  const ciphertext = encrypted.payload.subarray(0, encrypted.payload.length - 16);
  const tag = encrypted.payload.subarray(encrypted.payload.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.iv);
  decipher.setAAD(Buffer.alloc(0));
  decipher.setAuthTag(tag);
  const decoded = proto.Message.decode(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  const edited = decoded.protocolMessage?.editedMessage;
  return edited?.conversation ?? edited?.extendedTextMessage?.text ?? null;
}
