import { z } from "zod/v4";
import { nanoid } from "nanoid";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SiteDb } from "../db.js";
import type { SiteStorage, FileEntry } from "../storage.js";
import { type ServerConfig, resolveExpiresAt } from "../config.js";

// ---- Input schema ----

export const deploySiteInputSchema = {
  name: z
    .string()
    .optional()
    .describe("Human-readable site name. Auto-generated when omitted."),
  files: z
    .array(
      z.object({
        path: z.string().describe('Relative file path, e.g. "index.html" or "css/style.css"'),
        content: z.string().describe("Base64-encoded file content"),
      })
    )
    .optional()
    .describe("Upload individual files with base64 content. Mutually exclusive with zip_base64 and source_path."),
  zip_base64: z
    .string()
    .optional()
    .describe("Entire site as a base64-encoded ZIP archive. Mutually exclusive with files and source_path."),
  source_path: z
    .string()
    .optional()
    .describe("Absolute path on the server where site files already exist. Mutually exclusive with files and zip_base64."),
  ttl: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Survival time (TTL) for the site, e.g. 3600 (seconds), '30m', '12h', '7d', or 'never'. If omitted, the server default TTL is used when configured."),
};

// ---- Tool metadata (enterprise MCP best practices) ----

export const deploySiteToolConfig = {
  title: "Deploy Site",
  description:
    "Deploy a static HTML site. Accepts files via base64 file list, base64 ZIP archive, or a local server path. " +
    "Returns the site ID and public URL. Supported file types: html, css, js, images, fonts, etc.",
  inputSchema: deploySiteInputSchema,
  annotations: {
    title: "Deploy Site",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

// ---- Handler ----

export function createDeploySiteHandler(db: SiteDb, storage: SiteStorage, config: ServerConfig) {
  return async (args: {
    name?: string;
    files?: FileEntry[];
    zip_base64?: string;
    source_path?: string;
    ttl?: number | string;
  }): Promise<CallToolResult> => {
    const { name, files, zip_base64, source_path, ttl } = args;

    // Validate: exactly one source must be provided
    const sources = [files, zip_base64, source_path].filter(Boolean);
    if (sources.length === 0) {
      return {
        content: [{ type: "text", text: "Error: You must provide exactly one of: files, zip_base64, or source_path." }],
        isError: true,
      };
    }
    if (sources.length > 1) {
      return {
        content: [{ type: "text", text: "Error: Only one of files, zip_base64, or source_path may be provided at a time." }],
        isError: true,
      };
    }

    const siteId = nanoid(8);
    const siteName = name ?? `site-${siteId}`;

    try {
      let filesCount: number;

      if (files && files.length > 0) {
        filesCount = storage.writeFiles(siteId, files);
      } else if (zip_base64) {
        filesCount = storage.extractZip(siteId, zip_base64);
      } else if (source_path) {
        filesCount = storage.copyFromLocal(siteId, source_path);
      } else {
        return {
          content: [{ type: "text", text: "Error: No file content provided." }],
          isError: true,
        };
      }

      const url = `${config.baseUrl.replace(/\/+$/, "")}/${siteId}/`;
      const now = new Date().toISOString();

      const expiresAt = resolveExpiresAt(ttl, config);

      db.add({
        siteId,
        name: siteName,
        dir: storage.siteDir(siteId),
        url,
        filesCount,
        createdAt: now,
        updatedAt: now,
        expiresAt,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "deployed",
                site_id: siteId,
                name: siteName,
                url,
                files_count: filesCount,
                expires_at: expiresAt ?? "never",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      // Clean up partially-written files on failure
      storage.removeSite(siteId);
      return {
        content: [{ type: "text", text: `Deployment failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  };
}
