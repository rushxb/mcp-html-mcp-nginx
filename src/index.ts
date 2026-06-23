import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { nanoid } from "nanoid";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { SiteDb } from "./db.js";
import { SiteStorage } from "./storage.js";
import { createMcpServer } from "./server.js";
import { resolveExpiresAt } from "./config.js";
import { parseMultipartUpload } from "./upload.js";

// ---- Bootstrap ----

const config = loadConfig();
console.log(`[bootstrap] Loaded config:`, {
  port: config.port,
  host: config.host,
  apiKey: config.apiKey ? "***" : undefined,
  defaultTtl: config.defaultTtl,
  cleanupInterval: config.cleanupInterval,
  maxTtl: config.maxTtl,
});
const db = new SiteDb(config.dbPath);
const storage = new SiteStorage(config);

// ---- Express application ----

const app = express();
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
app.use(express.json({ limit: "100mb" }));

// Active transports keyed by session ID
const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};
const authenticatedSessions = new Set<string>();

/**
 * Validate API key if configured.
 */
function validateRequestApiKey(req: Request, res: Response): boolean {
  if (!config.apiKey) {
    return true;
  }

  const authHeader = req.headers["authorization"];
  let clientKey = "";

  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      clientKey = parts[1];
    } else {
      clientKey = authHeader;
    }
  }

  if (!clientKey && req.headers["x-api-key"]) {
    clientKey = req.headers["x-api-key"] as string;
  }

  if (!clientKey && req.query.apiKey) {
    clientKey = req.query.apiKey as string;
  }

  if (clientKey === config.apiKey) {
    return true;
  }

  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Unauthorized: Invalid or missing API key" },
    id: null,
  });
  return false;
}

// ===========================================================================
// Streamable HTTP transport  (protocol version 2025-03-26)
// ===========================================================================

app.all("/mcp", async (req: Request, res: Response) => {
  if (!validateRequestApiKey(req, res)) return;
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    const existing = transports[sessionId];
    if (!(existing instanceof StreamableHTTPServerTransport)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session uses a different transport protocol" },
        id: null,
      });
      return;
    }
    transport = existing;
  } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
        console.log(`[streamable-http] Session created: ${sid}`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && transports[sid]) {
        delete transports[sid];
        console.log(`[streamable-http] Session closed: ${sid}`);
      }
    };

    const server = createMcpServer(config, db, storage);
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// ===========================================================================
// SSE transport  (protocol version 2024-11-05, backwards-compatible)
// ===========================================================================

app.get("/sse", async (req: Request, res: Response) => {
  if (!validateRequestApiKey(req, res)) return;
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  authenticatedSessions.add(transport.sessionId);
  console.log(`[sse] Session created: ${transport.sessionId}`);

  res.on("close", () => {
    delete transports[transport.sessionId];
    authenticatedSessions.delete(transport.sessionId);
    console.log(`[sse] Session closed: ${transport.sessionId}`);
  });

  const server = createMcpServer(config, db, storage);
  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  if (!authenticatedSessions.has(sessionId) && !validateRequestApiKey(req, res)) return;
  const existing = transports[sessionId];

  if (!existing || !(existing instanceof SSEServerTransport)) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid or missing SSE session" },
      id: null,
    });
    return;
  }

  await existing.handlePostMessage(req, res, req.body);
});

// ===========================================================================
// HTTP file upload deployment API
// ===========================================================================

app.post("/upload/files", async (req: Request, res: Response) => {
  if (!validateRequestApiKey(req, res)) return;

  try {
    const form = await parseMultipartUpload(req, config.maxUploadBytes);
    if (form.files.length === 0) {
      res.status(400).json({ error: "No files uploaded. Send multipart/form-data with one or more file parts." });
      return;
    }

    const siteId = nanoid(8);
    const siteName = form.fields.name || `site-${siteId}`;
    const expiresAt = resolveExpiresAt(form.fields.ttl, config);

    try {
      const filesCount = storage.writeFileBuffers(siteId, form.files);
      const url = `${config.baseUrl.replace(/\/+$/, "")}/${siteId}/`;
      const now = new Date().toISOString();

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

      res.json({
        status: "deployed",
        site_id: siteId,
        name: siteName,
        url,
        files_count: filesCount,
        expires_at: expiresAt ?? "never",
        usage_hint: "Upload deployment succeeded. Open the url field in a browser.",
      });
    } catch (err) {
      storage.removeSite(siteId);
      throw err;
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ===========================================================================
// Health check
// ===========================================================================

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0" });
});

// ===========================================================================
// Start
// ===========================================================================

function cleanExpiredSites() {
  try {
    const now = new Date();
    const sites = db.list();
    let cleanedCount = 0;
    for (const site of sites) {
      if (site.expiresAt && now > new Date(site.expiresAt)) {
        console.log(`[cleanup] Site "${site.siteId}" (${site.name}) expired at ${site.expiresAt}. Deleting...`);
        storage.removeSite(site.siteId);
        db.remove(site.siteId);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      console.log(`[cleanup] Cleaned up ${cleanedCount} expired sites.`);
    }
  } catch (err) {
    console.error("[cleanup] Error cleaning up expired sites:", err);
  }
}

cleanExpiredSites();
setInterval(cleanExpiredSites, config.cleanupInterval);

const PORT = config.port;
const HOST = config.host;

app.listen(PORT, HOST, () => {
  console.log(`
==============================================
  MCP HTML Deploy Server  v1.0.0
==============================================

  Listening:  http://${HOST}:${PORT}

  Transports:
    Streamable HTTP : POST/GET/DELETE /mcp
    SSE (legacy)    : GET /sse  +  POST /messages

  Upload API:
    POST /upload/files  multipart/form-data

  Health check:     GET /health

  Sites directory:  ${config.sitesDir}
  Base URL:         ${config.baseUrl}
==============================================
`);
});

// ---- Graceful shutdown ----

async function shutdown() {
  console.log("\nShutting down...");
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid].close();
      delete transports[sid];
      authenticatedSessions.delete(sid);
    } catch {
      // best-effort
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
