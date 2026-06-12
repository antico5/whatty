import type { Contact } from "baileys";
import type { JobHandler } from "../types.js";
import { contactObservation, observeAccounts } from "./shared.js";

/**
 * `process-contacts` — name/identity sightings. A contact can arrive after its
 * chat was already persisted (events have no guaranteed order). Order no
 * longer matters: the names land on the account row whenever they're seen,
 * and `observeAccounts` announces any existing chat of that peer so it never
 * stays stuck at "Not Contact".
 */
export const processContacts: JobHandler = async (payload) => {
  const contacts = payload as Contact[];
  return { changes: await observeAccounts(contacts.map(contactObservation)) };
};
