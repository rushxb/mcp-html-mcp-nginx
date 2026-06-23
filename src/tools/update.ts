import { z } from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SiteDb } from "../db.js";
import type { SiteStorage, FileEntry } from "../storage.js";
import { type ServerConfig, resolveExpiresAt } from "../config.js";

// ---- Input schema ----

export const updateSiteInputSchema = {
  site_id: z.string().describe("The site_id returned by deploy_site or list_sites. Required to identify which deployed site to update."),
  files: z
    .array(
      z.object({
        path: z.string().describe('Relative file path inside the existing site, e.g. "index.html" or "assets/app.js". Do not use absolute paths or ../ segments.'),
        content: z.string().describe("Base64-encoded replacement or new file bytes."),
      })
    )
    .optional()
    .describe("Upload replacement or additional individual files. Mutually exclusive with zip_base64. Omit when only changing ttl."),
  zip_base64: z
    .string()
    .optional()
    .describe("Base64-encoded ZIP archive used to update the site. Mutually exclusive with files. Use clean=true when the ZIP should replace the whole site."),
  clean: z
    .boolean()
    .optional()
    .default(false)
    .describe("When true, remove all existing files before writing the provided files or ZIP. Use carefully for full replacement. Default false."),
  ttl: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Optional new survival time from now. Examples: 3600, '30m', '12h', '7d', or 'never' to remove expiration. You may call update_site with only site_id and ttl to extend or shorten a site lifetime."),
};

// ---- Tool metadata ----

export const updateSiteToolConfig = {
  title: "Update Deployed Website",
  description:
    "Update an existing deployed static website. Use this to replace files, add files, upload a ZIP, fully clean and redeploy, or change the site's TTL. " +
    "To only extend, shorten, or remove expiration, provide site_id and ttl without files. After success, show the returned url and expires_at to the user.",
  inputSchema: updateSiteInputSchema,
  annotations: {
    title: "Update Deployed Website",
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
                usage_hint: "Update succeeded. Present the url field to the user if they need to access the site.",
                next_action: "Tell the user what changed and include expires_at when TTL was requested.",
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
