import { jidNormalizedUser } from "baileys";
import type { JobHandler } from "../types.js";
import { observeAccounts, registerPairs } from "./shared.js";

export interface OwnIdentityPayload {
  id: string;
  lid: string | null;
  name: string | null;
}

/**
 * `own-identity` — our own lid↔pn pair never arrives through message keys —
 * our lid shows up only inside *other people's* quoted refs
 * (`contextInfo.participant`), which carry no alt-jid — so quoted replies to
 * our own messages would render the raw `@lid`. The socket knows both of our
 * identities once the connection opens; the payload is captured at enqueue
 * time (status `open`) and landed here like any other pairing.
 */
export const ownIdentity: JobHandler = async (payload) => {
  const { id, lid, name } = payload as OwnIdentityPayload;
  const normalizedId = jidNormalizedUser(id);
  const normalizedLid = lid ? jidNormalizedUser(lid) : null;

  const changes = await observeAccounts([{ jids: [normalizedId, normalizedLid], pushName: name ?? null }]);
  if (normalizedLid) changes.push(...(await registerPairs(new Map([[normalizedLid, normalizedId]]))));
  return { changes };
};
