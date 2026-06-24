import { z } from "zod/v4";
import { nanoid } from "nanoid";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SiteDb } from "../db.js";
import type { SiteStorage, FileEntry } from "../storage.js";
import { type ServerConfig, resolveExpiresAt } from "../config.js";
import { validateDeployment } from "../validation.js";

// ---- Input schema ----

export const deploySiteInputSchema = {
  name: z
    .string()
    .optional()
    .describe("Optional human-readable site name for later listing. Use the user's project/page name when available. Auto-generated when omitted."),
  files: z
    .array(
      z.object({
        path: z.string().describe('Relative file path inside the deployed site, e.g. "index.html", "assets/app.js", or "css/style.css". Do not use absolute paths or ../ segments.'),
        content: z.string().describe("Base64-encoded file bytes. Encode the exact file content as base64 before calling this tool."),
      })
    )
    .optional()
    .describe("Upload one or more individual files. Best for LLM-generated pages. Must include index.html for browser-friendly access. Mutually exclusive with zip_base64 and source_path."),
  zip_base64: z
    .string()
    .optional()
    .describe("Base64-encoded ZIP archive containing the entire static site. Use for multi-file folders. Mutually exclusive with files and source_path."),
  source_path: z
    .string()
    .optional()
    .describe("Absolute path on the MCP server where site files already exist. Use only when the files are already on the server. Mutually exclusive with files and zip_base64."),
  ttl: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Optional survival time for the deployed site. Examples: 3600 for seconds, '30m', '12h', '7d', or 'never'. If omitted, the server default TTL is used. If a maximum TTL is configured, values above it are rejected."),
  spa: z
    .boolean()
    .optional()
    .default(false)
    .describe("Set true for single-page applications using client-side routing. The response will include SPA routing guidance for /sites/{siteId}/ deep links."),
};

// ---- Tool metadata (enterprise MCP best practices) ----

export const deploySiteToolConfig = {
  title: "Deploy Static Website",
  description:
    "Deploy a static frontend website and return a public URL from MCP arguments. Prefer get_upload_instructions plus the HTTP upload API when the user wants to upload real local files or folders. " +
    "Use this tool mainly for small LLM-generated pages, already-base64 file payloads, ZIP payloads, or server-side source_path deployments. Provide exactly one source: files, zip_base64, or source_path. " +
    "After success, show the returned url field directly to the user. Do not invent or rewrite the URL.",
  inputSchema: deploySiteInputSchema,
  annotations: {
    title: "Deploy Static Website",
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
    spa?: boolean;
  }): Promise<CallToolResult> => {
    const { name, files, zip_base64, source_path, ttl, spa } = args;

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
      const validation = validateDeployment(storage.siteDir(siteId));

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
        spa: Boolean(spa),
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
                entry_url: validation.entry_file ? `${url}${validation.entry_file}` : url,
                files_count: filesCount,
                expires_at: expiresAt ?? "never",
                spa: Boolean(spa),
                validation,
                usage_hint: "Deployment succeeded. Present the url field to the user as the public access link.",
                next_action:
                  validation.warnings.length > 0
                    ? "Tell the user the site is deployed, include the url, and mention validation warnings that may affect browser access."
                    : "Tell the user the site is deployed and include the url. Use update_site to change files or TTL later.",
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
