import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Server configuration.
 *
 * All settings can be overridden via environment variables.
 * Sensible defaults are provided for quick local development.
 */
export interface ServerConfig {
  /** HTTP port the MCP server listens on. */
  port: number;
  /** Host the MCP server binds to. */
  host: string;
  /** Root directory where deployed sites are stored on disk. */
  sitesDir: string;
  /** Base URL prefix used by Nginx to serve the deployed sites. */
  baseUrl: string;
  /** JSON metadata file path. */
  dbPath: string;
  /**
   * Allowed static file extensions (lowercase, with leading dot).
   * Files not matching this list will be rejected on upload.
   */
  allowedExtensions: string[];
  /** Maximum total upload size in bytes (default 50 MB). */
  maxUploadBytes: number;
  /** Optional authentication API key required for MCP connections. */
  apiKey?: string;
  /** Optional default TTL in seconds for deployed sites. */
  defaultTtl?: number;
  /** Optional maximum TTL in seconds for deployed sites. */
  maxTtl?: number;
  /** Cleanup interval in milliseconds for expired sites (default 60000). */
  cleanupInterval: number;
}

/**
 * Load a local .env file without adding a runtime dependency.
 * Existing process.env values always win, which keeps container/PM2 overrides predictable.
 */
function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * Parse TTL string (e.g. "30m", "2h", "1d") or number into seconds.
 */
export function parseTtl(ttl: number | string): number {
  if (typeof ttl === "number") {
    return ttl;
  }
  const cleaned = ttl.trim();
  const num = parseFloat(cleaned);
  if (isNaN(num)) {
    throw new Error(`Invalid TTL value: "${ttl}"`);
  }
  const unit = cleaned.replace(/^[0-9.]+\s*/, "").toLowerCase();
  switch (unit) {
    case "":
    case "s":
    case "sec":
    case "second":
    case "seconds":
      return Math.round(num);
    case "m":
    case "min":
    case "minute":
    case "minutes":
      return Math.round(num * 60);
    case "h":
    case "hr":
    case "hour":
    case "hours":
      return Math.round(num * 3600);
    case "d":
    case "day":
    case "days":
      return Math.round(num * 86400);
    case "w":
    case "week":
    case "weeks":
      return Math.round(num * 86400 * 7);
    default:
      throw new Error(`Unknown TTL unit: "${unit}" in "${ttl}". Supported units: s, m, h, d, w`);
  }
}

export function resolveExpiresAt(ttl: number | string | undefined, config: Pick<ServerConfig, "defaultTtl" | "maxTtl">): string | undefined {
  const resolvedTtl = ttl !== undefined ? ttl : config.defaultTtl;
  if (resolvedTtl === undefined) return undefined;

  if (typeof resolvedTtl === "string") {
    const normalized = resolvedTtl.trim().toLowerCase();
    if (["never", "none", "infinite", "forever", "permanent"].includes(normalized)) {
      return undefined;
    }
  }

  const ttlSeconds = parseTtl(resolvedTtl);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("TTL must be greater than 0 seconds, or use 'never' to disable expiration.");
  }
  if (config.maxTtl !== undefined && ttlSeconds > config.maxTtl) {
    throw new Error(`TTL exceeds maximum allowed value of ${config.maxTtl} seconds`);
  }

  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

export function loadConfig(): ServerConfig {
  loadDotEnv();
  const dataDir = resolve(process.env.MCP_DATA_DIR ?? resolve(__dirname, "..", "data"));

  return {
    apiKey: process.env.MCP_API_KEY || undefined,
    defaultTtl: process.env.MCP_DEFAULT_TTL ? parseTtl(process.env.MCP_DEFAULT_TTL) : undefined,
    maxTtl: process.env.MCP_MAX_TTL ? parseTtl(process.env.MCP_MAX_TTL) : undefined,
    cleanupInterval: parseInt(process.env.MCP_CLEANUP_INTERVAL ?? "60000", 10),
    port: parseInt(process.env.MCP_PORT ?? "3000", 10),
    host: process.env.MCP_HOST ?? "0.0.0.0",
    sitesDir: process.env.MCP_SITES_DIR ?? resolve(dataDir, "sites"),
    baseUrl: process.env.MCP_BASE_URL ?? "http://localhost/sites",
    dbPath: process.env.MCP_DB_PATH ?? resolve(dataDir, "db.json"),
    allowedExtensions: (
      process.env.MCP_ALLOWED_EXTENSIONS ??
      ".html,.htm,.css,.js,.json,.png,.jpg,.jpeg,.gif,.svg,.ico,.webp,.woff,.woff2,.ttf,.eot,.map,.txt,.xml,.webmanifest,.mp4,.mp3,.pdf"
    )
      .split(",")
      .map((e) => e.trim().toLowerCase()),
    maxUploadBytes: parseInt(process.env.MCP_MAX_UPLOAD_BYTES ?? String(50 * 1024 * 1024), 10),
  };
}
