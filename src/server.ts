import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "./config.js";
import { SiteDb } from "./db.js";
import { SiteStorage } from "./storage.js";
import { deploySiteToolConfig, createDeploySiteHandler } from "./tools/deploy.js";
import { listSitesToolConfig, createListSitesHandler } from "./tools/list.js";
import { deleteSiteToolConfig, createDeleteSiteHandler } from "./tools/delete.js";
import { updateSiteToolConfig, createUpdateSiteHandler } from "./tools/update.js";

/**
 * Create a fully-configured MCP server instance.
 *
 * Each transport connection gets its own McpServer instance but they
 * share the same DB and storage layer (singleton within the process).
 */
export function createMcpServer(config: ServerConfig, db: SiteDb, storage: SiteStorage): McpServer {
  const server = new McpServer(
    {
      name: "mcp-html-nginx",
      version: "1.0.0",
    },
    {
      capabilities: {
        logging: {},
      },
    }
  );

  // ---- Register tools ----

  server.registerTool("deploy_site", deploySiteToolConfig, createDeploySiteHandler(db, storage, config));
  server.registerTool("list_sites", listSitesToolConfig, createListSitesHandler(db));
  server.registerTool("delete_site", deleteSiteToolConfig, createDeleteSiteHandler(db, storage));
  server.registerTool("update_site", updateSiteToolConfig, createUpdateSiteHandler(db, storage, config));

  return server;
}
