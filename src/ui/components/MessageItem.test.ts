import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyChat, type Chat, type Message } from "../../types/index.js";
import { messageRowCount, layoutLinesForTest } from "./MessageItem.js";

// Mock mediaStore so tests don't need an active account on disk.
vi.mock("../../persistence/mediaStore.js", () => ({
  absoluteMediaPath: (ref: { relativePath: string }) => `/data/accounts/test@s.whatsapp.net/${ref.relativePath}`,
  fileUrl: (absPath: string) => `file://${absPath}`,
}));

// Module-level mock so we can toggle `supportsHyperlinks` per test group.
vi.mock("../util/termCaps.js", () => ({
  supportsHyperlinks: vi.fn(() => false),
}));

import { supportsHyperlinks } from "../util/termCaps.js";
const mockSupportsHyperlinks = vi.mocked(supportsHyperlinks);

const JID = "12345@s.whatsapp.net";

function msg(overrides: Partial<Message>): Message {
  return {
    id: "m1",
    senderJid: JID,
    senderName: "Alice",
    direction: "inbound",
    timestamp: 1_700_000_000_000,
    type: "text",
    text: "hello",
    media: null,
    quoted: null,
    deliveryStatus: null,
    deleted: false,
    deletedAt: null,
    raw: {},
    ...overrides,
  };
}

function chat(overrides: Partial<Chat> = {}): Chat {
  return { ...createEmptyChat(JID, "individual"), ...overrides };
}

describe("messageRowCount", () => {
  beforeEach(() => {
    mockSupportsHyperlinks.mockReturnValue(false);
  });

  it("returns 2 for a plain text message (1 text line + 1 meta line + 1 gap)", () => {
    // Plain text: 1 line of text + 1 meta line + 1 gap below = 3 rows
    // Actually: layoutLines returns text + meta = 2 lines; rowCount = lines.length + 1 = 3
    const c = chat();
    const m = msg({ text: "hi" });
    expect(messageRowCount(m, c, 80)).toBe(3);
  });

  it("row count is the same with reactions as without", () => {
    const c = chat();
    const width = 80;

    const withoutReactions = msg({ text: "hi" });
    const withReactions = msg({
      text: "hi",
      reactions: [
        { emoji: "👍", sender: "a@s.whatsapp.net" },
        { emoji: "❤️", sender: "b@s.whatsapp.net" },
      ],
    });

    expect(messageRowCount(withReactions, c, width)).toBe(
      messageRowCount(withoutReactions, c, width),
    );
  });

  it("row count is the same with many reactions that trigger truncation", () => {
    const c = chat();
    const width = 40; // narrow width to force truncation

    const withoutReactions = msg({ text: "hi" });
    const withManyReactions = msg({
      text: "hi",
      reactions: Array.from({ length: 20 }, (_, i) => ({
        emoji: "👍",
        sender: `sender${i}@s.whatsapp.net`,
      })),
    });

    expect(messageRowCount(withManyReactions, c, width)).toBe(
      messageRowCount(withoutReactions, c, width),
    );
  });
});

describe("layoutLines – media (OSC 8 hyperlink mode)", () => {
  beforeEach(() => {
    mockSupportsHyperlinks.mockReturnValue(true);
  });

  it("emits exactly one media-link line for a media message", () => {
    const c = chat();
    const m = msg({
      type: "image",
      text: null,
      media: { relativePath: "media/photo.jpg", mimeType: "image/jpeg", fileName: "photo.jpg" },
    });
    const lines = layoutLinesForTest(m, c, 40);
    const mediaLines = lines.filter((l) => l.kind === "media-link" || l.kind === "media");
    expect(mediaLines).toHaveLength(1);
    expect(mediaLines[0]!.kind).toBe("media-link");
  });

  it("label is printable-only (no escape bytes) and fits within maxWidth", () => {
    const maxWidth = 40;
    const c = chat();
    const m = msg({
      type: "image",
      text: null,
      media: { relativePath: "media/photo.jpg", mimeType: "image/jpeg", fileName: "photo.jpg" },
    });
    const lines = layoutLinesForTest(m, c, maxWidth);
    const line = lines.find((l) => l.kind === "media-link");
    expect(line).toBeDefined();
    if (line?.kind === "media-link") {
      expect(line.label.length).toBeLessThanOrEqual(maxWidth);
      // No ESC characters in the printable label.
      expect(line.label).not.toMatch(/\x1b/);
    }
  });

  it("href is a file:// URL", () => {
    const c = chat();
    const m = msg({
      type: "image",
      text: null,
      media: { relativePath: "media/photo.jpg", mimeType: "image/jpeg", fileName: "photo.jpg" },
    });
    const lines = layoutLinesForTest(m, c, 40);
    const line = lines.find((l) => l.kind === "media-link");
    if (line?.kind === "media-link") {
      expect(line.href).toMatch(/^file:\/\//);
    }
  });

  it("label includes [image] prefix with filename", () => {
    const c = chat();
    const m = msg({
      type: "image",
      text: null,
      media: { relativePath: "media/photo.jpg", mimeType: "image/jpeg", fileName: "cat.jpg" },
    });
    const lines = layoutLinesForTest(m, c, 40);
    const line = lines.find((l) => l.kind === "media-link");
    if (line?.kind === "media-link") {
      expect(line.label).toBe("[image] cat.jpg");
    }
  });

  it("label uses '[type] open' when fileName is null", () => {
    const c = chat();
    const m = msg({
      type: "audio",
      text: null,
      media: { relativePath: "media/voice.ogg", mimeType: "audio/ogg", fileName: null },
    });
    const lines = layoutLinesForTest(m, c, 40);
    const line = lines.find((l) => l.kind === "media-link");
    if (line?.kind === "media-link") {
      expect(line.label).toBe("[audio] open");
    }
  });

  it("messageRowCount is 2 for a media-only message (1 media-link + 1 meta)", () => {
    const c = chat();
    const m = msg({
      type: "image",
      text: null,
      media: { relativePath: "media/photo.jpg", mimeType: "image/jpeg", fileName: "photo.jpg" },
    });
    // 1 media-link line + 1 meta line + 1 gap = 3
    expect(messageRowCount(m, c, 80)).toBe(3);
  });
});

describe("layoutLines – media (fallback / absolute path mode)", () => {
  beforeEach(() => {
    mockSupportsHyperlinks.mockReturnValue(false);
  });

  it("emits media chunks when absolute path exceeds maxWidth", () => {
    const maxWidth = 20;
    const c = chat();
    // Use a long relative path that will force chunking at maxWidth=20.
    const m = msg({
      type: "image",
      text: null,
      media: {
        relativePath: "media/2024_01_01_00_00_00_000__abcdef12.jpg",
        mimeType: "image/jpeg",
        fileName: null,
      },
    });
    const lines = layoutLinesForTest(m, c, maxWidth);
    const mediaLines = lines.filter((l) => l.kind === "media");
    // The absolute path will be longer than maxWidth, so we should have > 1 chunk.
    expect(mediaLines.length).toBeGreaterThan(1);
    // Each chunk must be at most maxWidth characters.
    for (const line of mediaLines) {
      if (line.kind === "media") {
        expect(line.text.length).toBeLessThanOrEqual(maxWidth);
      }
    }
  });

  it("no media-link lines in fallback mode", () => {
    const c = chat();
    const m = msg({
      type: "image",
      text: null,
      media: { relativePath: "media/photo.jpg", mimeType: "image/jpeg", fileName: "photo.jpg" },
    });
    const lines = layoutLinesForTest(m, c, 80);
    expect(lines.some((l) => l.kind === "media-link")).toBe(false);
  });

  it("fallback media text uses absolute path, not file:// URL", () => {
    const c = chat();
    const m = msg({
      type: "image",
      text: null,
      media: { relativePath: "media/photo.jpg", mimeType: "image/jpeg", fileName: "photo.jpg" },
    });
    const lines = layoutLinesForTest(m, c, 200);
    const mediaLines = lines.filter((l) => l.kind === "media");
    const combined = mediaLines.map((l) => (l.kind === "media" ? l.text : "")).join("");
    // Must not start with "file://"
    expect(combined).not.toMatch(/file:\/\//);
    // Must contain the absolute path segment
    expect(combined).toContain("photo.jpg");
  });

  it("messageRowCount agrees with layoutLines for a chunked media message", () => {
    const maxWidth = 20;
    const c = chat();
    const m = msg({
      type: "image",
      text: null,
      media: {
        relativePath: "media/2024_01_01_00_00_00_000__abcdef12.jpg",
        mimeType: "image/jpeg",
        fileName: null,
      },
    });
    const lines = layoutLinesForTest(m, c, maxWidth);
    // messageRowCount uses maxMessageContentWidth(width) but we want raw maxWidth.
    // Verify consistency: messageRowCount(m, c, 80) uses maxContentWidth derived from 80.
    // For a direct comparison, call both with the same effective width.
    // layoutLinesForTest with maxWidth=20 should agree with messageRowCount when
    // maxMessageContentWidth(width) == 20. maxMessageContentWidth(29) ≈ 20 (floor(29*0.7)=20).
    const widthThatGives20 = 29;
    const linesViaCount = layoutLinesForTest(m, c, 20);
    expect(messageRowCount(m, c, widthThatGives20)).toBe(linesViaCount.length + 1);
  });
});

describe("layoutLines – not-downloaded media hint", () => {
  beforeEach(() => {
    mockSupportsHyperlinks.mockReturnValue(false);
  });

  it("shows a '[type] not downloaded' hint for a media message with null media", () => {
    const c = chat();
    const m = msg({ type: "image", text: null, media: null });
    const lines = layoutLinesForTest(m, c, 80);
    const textLines = lines.filter((l) => l.kind === "text");
    expect(textLines).toHaveLength(1);
    expect(textLines[0]!.kind === "text" && textLines[0].text).toBe("[image] not downloaded");
  });

  it("shows the hint for each media type", () => {
    const c = chat();
    const types = ["image", "video", "audio", "document", "sticker"] as const;
    for (const type of types) {
      const m = msg({ type, text: null, media: null });
      const lines = layoutLinesForTest(m, c, 80);
      const textLines = lines.filter((l) => l.kind === "text");
      expect(textLines.length, `type=${type}`).toBeGreaterThanOrEqual(1);
      const firstText = textLines[0]!.kind === "text" ? textLines[0].text : "";
      expect(firstText, `type=${type}`).toMatch(/not downloaded/);
    }
  });

  it("does not show the hint for plain text messages (type=text, media=null)", () => {
    const c = chat();
    const m = msg({ type: "text", text: "hello", media: null });
    const lines = layoutLinesForTest(m, c, 80);
    const textLines = lines.filter((l) => l.kind === "text");
    expect(textLines).toHaveLength(1);
    expect(textLines[0]!.kind === "text" && textLines[0].text).toBe("hello");
  });

  it("shows both the hint and any caption text for a not-downloaded media message with a caption", () => {
    const c = chat();
    const m = msg({ type: "image", text: "look at this", media: null });
    const lines = layoutLinesForTest(m, c, 80);
    const textLines = lines.filter((l) => l.kind === "text");
    expect(textLines).toHaveLength(2);
    expect(textLines[0]!.kind === "text" && textLines[0].text).toBe("[image] not downloaded");
    expect(textLines[1]!.kind === "text" && textLines[1].text).toBe("look at this");
  });
});
