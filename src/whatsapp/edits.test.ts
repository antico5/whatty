import { createCipheriv, createHmac } from "node:crypto";
import { proto, type WAMessage } from "baileys";
import { describe, expect, it } from "vitest";
import type { Message } from "../types/index.js";
import { decryptEncryptedEdit, encryptedEditOf } from "./edits.js";

function hmac(data: Uint8Array, key: Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

describe("decryptEncryptedEdit", () => {
  it("decrypts and extracts edited text using the original message secret", () => {
    const targetId = "original";
    const sender = "123@s.whatsapp.net";
    const secret = Buffer.alloc(32, 7);
    const info = Buffer.concat([
      Buffer.from(targetId),
      Buffer.from(sender),
      Buffer.from(sender),
      Buffer.from("Message Edit"),
      Buffer.from([1]),
    ]);
    const key = hmac(info, hmac(secret, new Uint8Array(32)));
    const plaintext = proto.Message.encode({
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        editedMessage: { conversation: "Yooh" },
      },
    }).finish();
    const iv = Buffer.alloc(12, 2);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.alloc(0));
    const payload = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const envelope = {
      key: { remoteJid: sender, fromMe: true, id: "edit-envelope" },
      message: {
        secretEncryptedMessage: {
          targetMessageKey: { remoteJid: sender, fromMe: true, id: targetId },
          encPayload: payload,
          encIv: iv,
          secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
        },
      },
    } as unknown as WAMessage;
    const original = {
      id: targetId,
      raw: {
        message: { messageContextInfo: { messageSecret: secret } },
      },
    } as Message;

    const encrypted = encryptedEditOf(envelope);

    expect(encrypted).not.toBeNull();
    expect(decryptEncryptedEdit(encrypted!, original, sender, sender)).toBe("Yooh");
  });
});
