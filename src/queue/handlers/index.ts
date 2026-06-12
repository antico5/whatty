import type { JobHandler, JobType } from "../types.js";
import { processChats } from "./chats.js";
import { processContacts } from "./contacts.js";
import { applyEncryptedEdit } from "./encryptedEdit.js";
import { processGroups, refreshGroupMetadata } from "./groups.js";
import { processHistory } from "./history.js";
import { ownIdentity } from "./identity.js";
import { downloadMedia, sweepUnlinkedMedia } from "./media.js";
import { processMessages } from "./messages.js";
import { processMessageUpdate, processReaction, processReceipts } from "./updates.js";

export const jobHandlers: Record<JobType, JobHandler> = {
  "process-messages": processMessages,
  "process-history": processHistory,
  "process-message-update": processMessageUpdate,
  "process-receipts": processReceipts,
  "process-reaction": processReaction,
  "process-contacts": processContacts,
  "process-chats": processChats,
  "process-groups": processGroups,
  "own-identity": ownIdentity,
  "download-media": downloadMedia,
  "apply-encrypted-edit": applyEncryptedEdit,
  "refresh-group-metadata": refreshGroupMetadata,
  "sweep-unlinked-media": sweepUnlinkedMedia,
};
