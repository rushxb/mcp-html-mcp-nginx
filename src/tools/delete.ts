import { z } from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SiteDb } from "../db.js";
import type { SiteStorage } from "../storage.js";

// ---- Input schema ----

export const deleteSiteInputSchema = {
  site_id: z.string().describe("The site_id returned by deploy_site or list_sites. Required to delete the deployed website and its stored files."),
};

// ---- Tool metadata ----

export const deleteSiteToolConfig = {
  title: "Delete Deployed Website",
  description:
    "Delete a deployed static website by site_id. Removes its files from disk and deletes metadata. Use only when the user clearly asks to remove, delete, or clean up a deployed site. This action is irreversible.",
  inputSchema: deleteSiteInputSchema,
  annotations: {
    title: "Delete Deployed Website",
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
                usage_hint: "Deletion succeeded. Tell the user the site URL is no longer available.",
              },
            null,
            2
          ),
        },
      ],
    };
  };
}
