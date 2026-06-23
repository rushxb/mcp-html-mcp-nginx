import { z } from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SiteDb } from "../db.js";

// ---- Input schema ----

export const listSitesInputSchema = {
  keyword: z
    .string()
    .optional()
    .describe("Optional keyword to filter sites by name or ID (case-insensitive)."),
};

// ---- Tool metadata ----

export const listSitesToolConfig = {
  title: "List Sites",
  description:
    "List all deployed static sites. Returns site ID, name, URL, file count, and timestamps. " +
    "Optionally filter by keyword.",
  inputSchema: listSitesInputSchema,
  annotations: {
    title: "List Sites",
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
            },
            null,
            2
          ),
        },
      ],
    };
  };
}
