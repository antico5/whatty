import { useDiskUsage, useReadonly } from "../../store/StoreContext.js";
import { getBaileysVersion } from "../../whatsapp/version.js";
import { formatBytes } from "../util/format.js";
import { theme } from "../theme.js";

/**
 * Bottom status bar shared by all session screens (chat list and chat view).
 *
 * Left side: `baileys vX.Y.Z  db: X.X MB  media: X.X MB`
 *            plus an optional `read-only` tag.
 * Right side: reserved for future status indicators (e.g. "Working…").
 */
export function StatusBar() {
  const readonly = useReadonly();
  const diskUsage = useDiskUsage();

  return (
    <box style={{ flexDirection: "row" }}>
      <text {...theme.meta}>baileys v{getBaileysVersion()}</text>
      {diskUsage !== null ? (
        <text {...theme.meta}>
          {"  db: "}
          {formatBytes(diskUsage.db)}
          {"  media: "}
          {formatBytes(diskUsage.media)}
          {"  logs: "}
          {formatBytes(diskUsage.logs)}
        </text>
      ) : null}
      {readonly ? <text fg="cyan">{"  read-only"}</text> : null}
    </box>
  );
}
