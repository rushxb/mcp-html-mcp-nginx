import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, posix } from "node:path";

export interface DeploymentValidationWarning {
  code: string;
  message: string;
  path?: string;
}

export interface DeploymentValidationResult {
  entry_file: string | null;
  asset_count: number;
  checked_assets: string[];
  missing_assets: string[];
  warnings: DeploymentValidationWarning[];
  cache_hint: string;
  spa_hint?: string;
}

const ASSET_ATTR_RE = /(?:src|href)=["']([^"']+)["']/gi;
const HASHED_ASSET_RE = /[-.][A-Za-z0-9_-]{6,}\.(?:js|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|map)$/i;
const ROUTER_HISTORY_RE = /createWebHistory\s*\(/;

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function listFilesRecursive(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(full, rel));
    } else {
      files.push(toPosixPath(rel));
    }
  }
  return files;
}

function resolveAssetPath(entryFile: string, assetUrl: string): string | null {
  if (!assetUrl || assetUrl.startsWith("#") || assetUrl.startsWith("data:") || assetUrl.startsWith("mailto:") || assetUrl.startsWith("tel:")) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(assetUrl) || assetUrl.startsWith("//")) {
    return null;
  }

  const cleanUrl = assetUrl.split(/[?#]/, 1)[0];
  if (!cleanUrl) return null;
  if (cleanUrl.startsWith("/")) {
    return toPosixPath(cleanUrl.slice(1));
  }
  return toPosixPath(posix.normalize(posix.join(posix.dirname(entryFile), cleanUrl)));
}

function detectSpa(files: string[], siteDir: string): boolean {
  const jsFiles = files.filter((file) => extname(file).toLowerCase() === ".js").slice(0, 20);
  return jsFiles.some((file) => {
    const full = join(siteDir, file);
    const stat = statSync(full);
    if (stat.size > 5 * 1024 * 1024) return false;
    return ROUTER_HISTORY_RE.test(readFileSync(full, "utf-8"));
  });
}

export function validateDeployment(siteDir: string): DeploymentValidationResult {
  const files = listFilesRecursive(siteDir);
  const fileSet = new Set(files);
  const entryFile = fileSet.has("index.html") ? "index.html" : files.find((file) => extname(file).toLowerCase() === ".html") ?? null;
  const warnings: DeploymentValidationWarning[] = [];
  const checkedAssets: string[] = [];
  const missingAssets: string[] = [];

  if (!entryFile) {
    warnings.push({ code: "missing_entry_html", message: "No HTML entry file was found. Browser access may show a directory listing or 404." });
    return {
      entry_file: null,
      asset_count: 0,
      checked_assets: [],
      missing_assets: [],
      warnings,
      cache_hint: "Serve HTML entry files with no-cache and hashed assets with long immutable cache headers.",
    };
  }

  const html = readFileSync(join(siteDir, entryFile), "utf-8");
  for (const match of html.matchAll(ASSET_ATTR_RE)) {
    const rawUrl = match[1];
    const assetPath = resolveAssetPath(entryFile, rawUrl);
    if (!assetPath) continue;
    checkedAssets.push(assetPath);
    if (rawUrl.startsWith("/")) {
      warnings.push({
        code: "absolute_asset_path",
        path: rawUrl,
        message: "The entry HTML references an absolute asset path. For /sites/{siteId}/ deployments, prefer relative paths such as ./assets/app.js.",
      });
    }
    if (!fileSet.has(assetPath)) {
      missingAssets.push(assetPath);
    }
  }

  if (missingAssets.length > 0) {
    warnings.push({
      code: "missing_referenced_assets",
      message: `${missingAssets.length} asset(s) referenced by ${entryFile} were not found in the deployed site.`,
    });
  }

  const hashedAssets = checkedAssets.filter((asset) => HASHED_ASSET_RE.test(asset));
  const hasSpaRouting = detectSpa(files, siteDir);
  if (hasSpaRouting) {
    warnings.push({
      code: "spa_history_routing",
      message: "The deployed site appears to use history-mode SPA routing. Configure an index.html fallback for deep links, or use hash history.",
    });
  }

  return {
    entry_file: entryFile,
    asset_count: checkedAssets.length,
    checked_assets: checkedAssets.slice(0, 25),
    missing_assets: missingAssets,
    warnings,
    cache_hint: hashedAssets.length > 0
      ? "Use no-cache for index.html and long immutable caching for hashed assets. This prevents browsers from keeping stale entry HTML that points at removed asset names."
      : "Use no-cache for HTML entry files. Add content hashes to JS/CSS assets before enabling long browser caching.",
    spa_hint: hasSpaRouting ? "For Vue Router createWebHistory under /sites/{siteId}/, set a correct base path or add a server fallback to index.html." : undefined,
  };
}
