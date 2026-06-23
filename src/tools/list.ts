import { z } from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SiteDb } from "../db.js";

// ---- Input schema ----

export const listSitesInputSchema = {
  keyword: z
    .string()
    .optional()
    .describe("Optional keyword to filter sites by site_id or name, case-insensitive. Use this when the user references a known site name or partial ID."),
};

// ---- Tool metadata ----

export const listSitesToolConfig = {
  title: "List Deployed Websites",
  description:
    "List deployed static websites and their public URLs, IDs, file counts, creation/update times, and expiration times. " +
    "Use this to verify deployments, find a site_id before update/delete, or show the user currently hosted pages.",
  inputSchema: listSitesInputSchema,
  annotations: {
    title: "List Deployed Websites",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ---- Handler ----

export function createListSitesHandler(db: SiteDb) {
  return async (args: { keyword?: string }): Promise<CallToolResult> => {
    let sites = db.list();

    if (args.keyword) {
      const kw = args.keyword.toLowerCase();
      sites = sites.filter(
        (s) => s.siteId.toLowerCase().includes(kw) || s.name.toLowerCase().includes(kw)
      );
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              total: sites.length,
              sites: sites.map((s) => ({
                site_id: s.siteId,
                name: s.name,
                url: s.url,
                files_count: s.filesCount,
                created_at: s.createdAt,
                updated_at: s.updatedAt,
                expires_at: s.expiresAt ?? "never",
              })),
              usage_hint: "Use site_id for update_site or delete_site. Present url values directly when the user asks for access links.",
            },
            null,
            2
          ),
        },
      ],
    };
  };
}
