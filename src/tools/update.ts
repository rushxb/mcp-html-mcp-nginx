import { z } from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SiteDb } from "../db.js";
import type { SiteStorage, FileEntry } from "../storage.js";
import { type ServerConfig, resolveExpiresAt } from "../config.js";

// ---- Input schema ----

export const updateSiteInputSchema = {
  site_id: z.string().describe("The unique site ID to update."),
  files: z
    .array(
      z.object({
        path: z.string().describe('Relative file path, e.g. "index.html"'),
        content: z.string().describe("Base64-encoded file content"),
      })
    )
    .optional()
    .describe("Upload individual files. Mutually exclusive with zip_base64."),
  zip_base64: z
    .string()
    .optional()
    .describe("Entire site as a base64-encoded ZIP. Replaces all existing files. Mutually exclusive with files."),
  clean: z
    .boolean()
    .optional()
    .default(false)
    .describe("When true, remove all existing files before writing new ones. Default false."),
  ttl: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Update/extend survival time (TTL) for the site, e.g. 3600 (seconds), '30m', '12h', '7d', or 'never' to remove expiration."),
};

// ---- Tool metadata ----

export const updateSiteToolConfig = {
  title: "Update Site",
  description:
    "Update an existing deployed site. You can replace or add files via base64 list or ZIP. " +
    "Set clean=true to wipe existing files first.",
  inputSchema: updateSiteInputSchema,
  annotations: {
    title: "Update Site",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

// ---- Handler ----

export function createUpdateSiteHandler(db: SiteDb, storage: SiteStorage, config: ServerConfig) {
  return async (args: {
    site_id: string;
    files?: FileEntry[];
    zip_base64?: string;
    clean?: boolean;
    ttl?: number | string;
  }): Promise<CallToolResult> => {
    const record = db.findById(args.site_id);
    if (!record) {
      return {
        content: [{ type: "text", text: `Error: Site "${args.site_id}" not found.` }],
        isError: true,
      };
    }

    const sources = [args.files, args.zip_base64].filter(Boolean);
    if (sources.length === 0 && args.ttl === undefined) {
      return {
        content: [{ type: "text", text: "Error: You must provide files, zip_base64, or ttl." }],
        isError: true,
      };
    }
    if (sources.length > 1) {
      return {
        content: [{ type: "text", text: "Error: Only one of files or zip_base64 may be provided." }],
        isError: true,
      };
    }

    try {
      const shouldUpdateTtl = args.ttl !== undefined;
      const expiresAt = shouldUpdateTtl ? resolveExpiresAt(args.ttl, { defaultTtl: undefined, maxTtl: config.maxTtl }) : undefined;

      if (args.clean) {
        storage.removeSite(args.site_id);
      }

      let filesWritten = 0;
      if (args.files && args.files.length > 0) {
        filesWritten = storage.writeFiles(args.site_id, args.files);
      } else if (args.zip_base64) {
        filesWritten = storage.extractZip(args.site_id, args.zip_base64);
      }

      const totalFiles = storage.countFiles(args.site_id);
      db.update(args.site_id, {
        filesCount: totalFiles,
        ...(shouldUpdateTtl ? { expiresAt } : {}),
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "updated",
                site_id: args.site_id,
                name: record.name,
                url: record.url,
                files_written: filesWritten,
                total_files: totalFiles,
                expires_at: shouldUpdateTtl ? expiresAt ?? "never" : record.expiresAt ?? "never",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Update failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  };
}
