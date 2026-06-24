import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, rmSync, renameSync } from "node:fs";
import { resolve, extname, join, relative, basename } from "node:path";
import AdmZip from "adm-zip";
import type { ServerConfig } from "./config.js";

/** A single file to be written, with base64-encoded content. */
export interface FileEntry {
  /** Relative path inside the site, e.g. "index.html" or "css/style.css". */
  path: string;
  /** Base64-encoded file content. */
  content: string;
}

/** A single file to be written, with raw bytes. */
export interface BufferFileEntry {
  /** Relative path inside the site, e.g. "index.html" or "css/style.css". */
  path: string;
  /** Raw file bytes. */
  content: Buffer;
}

// ---- Helpers ----

const MAX_ZIP_FILE_COUNT = 5000;
const MAX_ZIP_ENTRY_DEPTH = 30;
const MAX_ZIP_COMPRESSION_RATIO = 100;
const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".npmrc",
  ".yarnrc",
  ".pnpmfile.cjs",
  "id_rsa",
  "id_dsa",
]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

/** Recursively count files in a directory. */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countFiles(join(dir, entry.name));
    } else {
      count += 1;
    }
  }
  return count;
}

/** Normalise a user-supplied relative path and guard against path traversal. */
function safePath(base: string, rel: string): string {
  // Convert backslashes, strip leading slash/dot-slash
  const normalised = rel.replace(/\\/g, "/").replace(/^\.?\/+/, "");
  const full = resolve(base, normalised);
  const relativePath = relative(base, full);
  if (relativePath.startsWith("..") || relativePath === "" || resolve(relativePath) === relativePath) {
    throw new Error(`Path traversal detected: "${rel}"`);
  }
  return full;
}

/** Reject credentials, repository internals, and other files that should never be publicly served. */
function assertSafePublicPath(rel: string): void {
  const normalised = rel.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const segments = normalised.split("/").filter(Boolean);
  if (segments.length > MAX_ZIP_ENTRY_DEPTH) {
    throw new Error(`Path is too deep: "${rel}"`);
  }
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (lower === ".git" || lower === ".svn" || lower === ".hg") {
      throw new Error(`Repository metadata is not allowed in public deployments: "${rel}"`);
    }
    if (lower.startsWith(".env")) {
      throw new Error(`Environment files are not allowed in public deployments: "${rel}"`);
    }
  }

  const fileName = basename(normalised).toLowerCase();
  const ext = extname(fileName).toLowerCase();
  if (SENSITIVE_FILE_NAMES.has(fileName) || SENSITIVE_EXTENSIONS.has(ext)) {
    throw new Error(`Sensitive file is not allowed in public deployments: "${rel}"`);
  }
}

/** Check that a filename has an allowed extension. */
function assertAllowedExt(filePath: string, allowed: string[]): void {
  const ext = extname(filePath).toLowerCase();
  // Allow extensionless files (e.g. CNAME, LICENSE)
  if (ext && !allowed.includes(ext)) {
    throw new Error(`File type not allowed: "${ext}" (file: ${filePath})`);
  }
}

function ensureCleanDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
}

// ---- Public API ----

export class SiteStorage {
  private readonly sitesDir: string;
  private readonly allowedExtensions: string[];
  private readonly maxUploadBytes: number;

  constructor(config: ServerConfig) {
    this.sitesDir = config.sitesDir;
    this.allowedExtensions = config.allowedExtensions;
    this.maxUploadBytes = config.maxUploadBytes;

    if (!existsSync(this.sitesDir)) {
      mkdirSync(this.sitesDir, { recursive: true });
    }
  }

  /** Return absolute site directory for a given site ID. */
  siteDir(siteId: string): string {
    return resolve(this.sitesDir, siteId);
  }

  /**
   * Write individual files into a site directory.
   * Returns the number of files written.
   */
  writeFiles(siteId: string, files: FileEntry[]): number {
    return this.writeFileBuffers(
      siteId,
      files.map((f) => ({ path: f.path, content: Buffer.from(f.content, "base64") }))
    );
  }

  /**
   * Write raw files into a site directory.
   * Returns the number of files written.
   */
  writeFileBuffers(siteId: string, files: BufferFileEntry[]): number {
    const base = this.siteDir(siteId);
    mkdirSync(base, { recursive: true });

    return this.writeFileBuffersToDir(base, files);
  }

  /** Replace all site files with a prepared file set, preserving the previous site on failure. */
  replaceWithFileBuffers(siteId: string, files: BufferFileEntry[]): number {
    const tempDir = this.tempSiteDir(siteId);
    try {
      ensureCleanDir(tempDir);
      const written = this.writeFileBuffersToDir(tempDir, files);
      this.swapSiteDir(siteId, tempDir);
      return written;
    } catch (err) {
      rmSync(tempDir, { recursive: true, force: true });
      throw err;
    }
  }

  private writeFileBuffersToDir(base: string, files: BufferFileEntry[]): number {
    mkdirSync(base, { recursive: true });

    let totalBytes = 0;
    for (const f of files) {
      assertSafePublicPath(f.path);
      const dest = safePath(base, f.path);
      assertAllowedExt(dest, this.allowedExtensions);
      const buf = f.content;
      totalBytes += buf.length;
      if (totalBytes > this.maxUploadBytes) {
        throw new Error(`Total upload size exceeds limit of ${this.maxUploadBytes} bytes`);
      }
      const dir = resolve(dest, "..");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(dest, buf);
    }
    return files.length;
  }

  /**
   * Extract a base64-encoded ZIP into a site directory.
   * Returns the number of extracted files.
   */
  extractZip(siteId: string, zipBase64: string): number {
    const zipBuf = Buffer.from(zipBase64, "base64");
    return this.extractZipBuffer(siteId, zipBuf);
  }

  /**
   * Extract a ZIP buffer into a site directory.
   * Returns the number of extracted files.
   */
  extractZipBuffer(siteId: string, zipBuf: Buffer): number {
    const base = this.siteDir(siteId);
    mkdirSync(base, { recursive: true });

    return this.extractZipBufferToDir(base, zipBuf);
  }

  /** Replace all site files with a ZIP archive, preserving the previous site on failure. */
  replaceWithZipBuffer(siteId: string, zipBuf: Buffer): number {
    const tempDir = this.tempSiteDir(siteId);
    try {
      ensureCleanDir(tempDir);
      const written = this.extractZipBufferToDir(tempDir, zipBuf);
      this.swapSiteDir(siteId, tempDir);
      return written;
    } catch (err) {
      rmSync(tempDir, { recursive: true, force: true });
      throw err;
    }
  }

  private extractZipBufferToDir(base: string, zipBuf: Buffer): number {
    mkdirSync(base, { recursive: true });

    if (zipBuf.length > this.maxUploadBytes) {
      throw new Error(`ZIP size exceeds limit of ${this.maxUploadBytes} bytes`);
    }

    const zip = new AdmZip(zipBuf);
    const entries = zip.getEntries();
    if (entries.length > MAX_ZIP_FILE_COUNT) {
      throw new Error(`ZIP contains too many entries. Limit is ${MAX_ZIP_FILE_COUNT}`);
    }

    let written = 0;
    let totalBytes = 0;

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      assertSafePublicPath(entry.entryName);
      if (entry.header.compressedSize > 0 && entry.header.size / entry.header.compressedSize > MAX_ZIP_COMPRESSION_RATIO) {
        throw new Error(`Suspicious ZIP compression ratio for entry: "${entry.entryName}"`);
      }
      const dest = safePath(base, entry.entryName);
      assertAllowedExt(dest, this.allowedExtensions);
      const data = entry.getData();
      totalBytes += data.length;
      if (totalBytes > this.maxUploadBytes) {
        throw new Error(`Total extracted ZIP size exceeds limit of ${this.maxUploadBytes} bytes`);
      }
      const dir = resolve(dest, "..");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(dest, data);
      written++;
    }
    return written;
  }

  /**
   * Copy from a local server path into a site directory.
   * Returns the number of files copied.
   */
  copyFromLocal(siteId: string, sourcePath: string): number {
    const src = resolve(sourcePath);
    if (!existsSync(src)) {
      throw new Error(`Source path does not exist: "${sourcePath}"`);
    }

    const base = this.siteDir(siteId);
    mkdirSync(base, { recursive: true });

    const stat = statSync(src);
    if (stat.isFile()) {
      assertSafePublicPath(src.split(/[/\\]/).pop()!);
      assertAllowedExt(src, this.allowedExtensions);
      const dest = resolve(base, src.split(/[/\\]/).pop()!);
      writeFileSync(dest, readFileSync(src));
      return 1;
    }

    return this.copyDirRecursive(src, base, base);
  }

  /** Recursively copy a directory, validating extensions. */
  private copyDirRecursive(src: string, dest: string, destRoot: string): number {
    let count = 0;
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      const publicPath = relative(destRoot, destPath);
      assertSafePublicPath(publicPath);
      if (entry.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        count += this.copyDirRecursive(srcPath, destPath, destRoot);
      } else {
        assertAllowedExt(srcPath, this.allowedExtensions);
        writeFileSync(destPath, readFileSync(srcPath));
        count++;
      }
    }
    return count;
  }

  /** Count all files in a site directory. */
  countFiles(siteId: string): number {
    return countFiles(this.siteDir(siteId));
  }

  /** Remove a site directory entirely. */
  removeSite(siteId: string): void {
    const dir = this.siteDir(siteId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private tempSiteDir(siteId: string): string {
    return resolve(this.sitesDir, `.tmp-${siteId}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  private backupSiteDir(siteId: string): string {
    return resolve(this.sitesDir, `.bak-${siteId}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  private swapSiteDir(siteId: string, preparedDir: string): void {
    const targetDir = this.siteDir(siteId);
    const backupDir = this.backupSiteDir(siteId);
    let hasBackup = false;

    try {
      if (existsSync(targetDir)) {
        renameSync(targetDir, backupDir);
        hasBackup = true;
      }
      renameSync(preparedDir, targetDir);
      if (hasBackup) {
        rmSync(backupDir, { recursive: true, force: true });
      }
    } catch (err) {
      if (existsSync(preparedDir)) {
        rmSync(preparedDir, { recursive: true, force: true });
      }
      if (hasBackup && !existsSync(targetDir) && existsSync(backupDir)) {
        renameSync(backupDir, targetDir);
      }
      throw err;
    }
  }
}
