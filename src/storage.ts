import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { resolve, extname, join, relative, posix } from "node:path";
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

/** Check that a filename has an allowed extension. */
function assertAllowedExt(filePath: string, allowed: string[]): void {
  const ext = extname(filePath).toLowerCase();
  // Allow extensionless files (e.g. CNAME, LICENSE)
  if (ext && !allowed.includes(ext)) {
    throw new Error(`File type not allowed: "${ext}" (file: ${filePath})`);
  }
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

    let totalBytes = 0;
    for (const f of files) {
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

    if (zipBuf.length > this.maxUploadBytes) {
      throw new Error(`ZIP size exceeds limit of ${this.maxUploadBytes} bytes`);
    }

    const zip = new AdmZip(zipBuf);
    const entries = zip.getEntries();
    let written = 0;
    let totalBytes = 0;

    for (const entry of entries) {
      if (entry.isDirectory) continue;
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
      assertAllowedExt(src, this.allowedExtensions);
      const dest = resolve(base, src.split(/[/\\]/).pop()!);
      writeFileSync(dest, readFileSync(src));
      return 1;
    }

    return this.copyDirRecursive(src, base);
  }

  /** Recursively copy a directory, validating extensions. */
  private copyDirRecursive(src: string, dest: string): number {
    let count = 0;
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        count += this.copyDirRecursive(srcPath, destPath);
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
}
