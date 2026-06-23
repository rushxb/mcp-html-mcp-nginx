import { z } from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SiteDb } from "../db.js";
import type { SiteStorage } from "../storage.js";

// ---- Input schema ----

export const deleteSiteInputSchema = {
  site_id: z.string().describe("The unique site ID to delete (e.g. 'a3xK9m')."),
};

// ---- Tool metadata ----

export const deleteSiteToolConfig = {
  title: "Delete Site",
  description:
    "Delete a deployed site by its ID. Removes all files from disk and the metadata record. This action is irreversible.",
  inputSchema: deleteSiteInputSchema,
  annotations: {
    title: "Delete Site",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ---- Handler ----

export function createDeleteSiteHandler(db: SiteDb, storage: SiteStorage) {
  return async (args: { site_id: string }): Promise<CallToolResult> => {
    const record = db.findById(args.site_id);
    if (!record) {
      return {
        content: [{ type: "text", text: `Error: Site "${args.site_id}" not found.` }],
        isError: true,
      };
    }

    storage.removeSite(args.site_id);
    db.remove(args.site_id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: "deleted",
              site_id: args.site_id,
              name: record.name,
            },
            null,
            2
          ),
        },
      ],
    };
  };
}
