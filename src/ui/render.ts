import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createElement } from "react";
import type { AppStore } from "../store/appStore.js";
import { App } from "./App.js";

/**
 * Boots the full-screen (alternate-screen) terminal renderer and mounts the
 * React app tree onto it. `Ctrl+C` is handled by `App` itself — via `onQuit`,
 * the same graceful-shutdown sequence used for `SIGINT`/`SIGTERM` — so the
 * renderer must not also act on it.
 */
export async function startUI(store: AppStore, onQuit: () => void): Promise<CliRenderer> {
  const renderer = await createCliRenderer({ screenMode: "alternate-screen", exitOnCtrlC: false });
  createRoot(renderer).render(createElement(App, { store, onQuit }));
  return renderer;
}
