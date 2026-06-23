import { z } from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../config.js";

export const uploadInstructionsInputSchema = {
  public_base_url: z
    .string()
    .optional()
    .describe("Optional public origin for the MCP HTTP service, e.g. https://deploy.example.com/mcp. If omitted, the caller should use the same origin used to connect to this MCP server."),
};

export const uploadInstructionsToolConfig = {
  title: "Get File Upload Instructions",
  description:
    "Return instructions for deploying a static website by uploading real files with multipart/form-data instead of embedding base64 file contents in MCP tool arguments. " +
    "Use this when the user wants to upload local frontend files or a folder. Tell the user to upload files to the returned endpoint, then use list_sites to verify the deployment.",
  inputSchema: uploadInstructionsInputSchema,
  annotations: {
    title: "Get File Upload Instructions",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export function createUploadInstructionsHandler(config: ServerConfig) {
  return async (args: { public_base_url?: string }): Promise<CallToolResult> => {
    const base = args.public_base_url?.replace(/\/+$/, "") || "<same-origin-as-this-MCP-server>";
    const uploadUrl = `${base}/upload/files`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              upload_url: uploadUrl,
              method: "POST",
              content_type: "multipart/form-data",
              auth: config.apiKey
                ? "Provide Authorization: Bearer <api_key>, x-api-key: <api_key>, or apiKey query parameter."
                : "No API key is configured.",
              fields: {
                file: "One or more file parts. The filename is used as the relative path unless a matching paths field is provided.",
                paths: "Optional repeated text field. Provide relative paths such as index.html or assets/app.js for uploaded files, useful for folder uploads.",
                name: "Optional human-readable site name.",
                ttl: "Optional survival time, e.g. 30m, 12h, 7d, or never.",
              },
              curl_example:
                `curl -X POST '${uploadUrl}' ` +
                `-H 'Authorization: Bearer <api_key>' ` +
                `-F 'name=my-site' ` +
                `-F 'ttl=72h' ` +
                `-F 'paths=index.html' -F 'file=@./index.html;filename=index.html' ` +
                `-F 'paths=assets/app.js' -F 'file=@./assets/app.js;filename=app.js'`,
              response: {
                status: "deployed",
                site_id: "string",
                url: "public website URL to show the user",
                expires_at: "ISO timestamp or never",
              },
              usage_hint:
                "Do not paste large HTML or asset contents into MCP arguments. Ask the user or client to upload real files to upload_url, then show the returned url.",
            },
            null,
            2
          ),
        },
      ],
    };
  };
}
