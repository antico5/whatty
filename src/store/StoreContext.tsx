import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { AccountInfo } from "../persistence/accounts.js";
import type { Chat } from "../types/index.js";
import type { AppPhase, AppStore, ConnectionInfo } from "./appStore.js";

const StoreContext = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useAppStore must be used within a StoreProvider");
  return store;
}

export function useChats(): Chat[] {
  const store = useAppStore();
  return useSyncExternalStore(store.subscribe, store.getChats);
}

export function useChat(jid: string): Chat | null {
  const store = useAppStore();
  return useSyncExternalStore(store.subscribe, () => store.getChat(jid));
}

export function useConnection(): ConnectionInfo {
  const store = useAppStore();
  return useSyncExternalStore(store.subscribe, store.getConnection);
}

export function usePhase(): AppPhase {
  const store = useAppStore();
  return useSyncExternalStore(store.subscribe, store.getPhase);
}

export function useAccounts(): AccountInfo[] {
  const store = useAppStore();
  return useSyncExternalStore(store.subscribe, store.getAccounts);
}

export function useReadonly(): boolean {
  return useAppStore().isReadonly();
}
