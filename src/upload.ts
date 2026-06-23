import type { Request } from "express";
import type { BufferFileEntry } from "./storage.js";

export interface UploadForm {
  fields: Record<string, string>;
  files: BufferFileEntry[];
}

function getBoundary(contentType: string | undefined): string {
  const match = contentType?.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) {
    throw new Error("Missing multipart boundary");
  }
  return boundary;
}

function parseContentDisposition(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  const parts = header.split(";").map((p) => p.trim());
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function decodeHeaderValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return Buffer.from(value, "latin1").toString("utf8");
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

async function readRequestBody(req: Request, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`Upload body exceeds limit of ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Minimal multipart/form-data parser for static site uploads.
 * Expected file fields: file, files, or any multipart part with filename.
 * Optional per-file relative path: part field name "paths" or "relativePath".
 */
export async function parseMultipartUpload(req: Request, maxBytes: number): Promise<UploadForm> {
  const boundary = getBoundary(req.headers["content-type"]);
  const body = await readRequestBody(req, maxBytes);
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: BufferFileEntry[] = [];
  const pendingPaths: string[] = [];

  let offset = body.indexOf(delimiter);
  if (offset === -1) throw new Error("Invalid multipart body");

  while (offset !== -1) {
    offset += delimiter.length;
    if (body.subarray(offset, offset + 2).toString() === "--") break;
    if (body.subarray(offset, offset + 2).toString() === "\r\n") offset += 2;

    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), offset);
    if (headerEnd === -1) break;

    const headers = parseHeaders(body.subarray(offset, headerEnd).toString("latin1"));
    const disposition = parseContentDisposition(headers["content-disposition"]);
    const fieldName = decodeHeaderValue(disposition.name) ?? "";
    const filename = decodeHeaderValue(disposition.filename);

    const dataStart = headerEnd + 4;
    const nextBoundary = body.indexOf(delimiter, dataStart);
    if (nextBoundary === -1) break;

    let dataEnd = nextBoundary;
    if (body.subarray(dataEnd - 2, dataEnd).toString() === "\r\n") {
      dataEnd -= 2;
    }
    const data = body.subarray(dataStart, dataEnd);

    if (filename !== undefined) {
      const relativePath = pendingPaths.shift() ?? filename;
      files.push({ path: relativePath, content: Buffer.from(data) });
    } else {
      const value = data.toString("utf8");
      if (fieldName === "paths" || fieldName === "relativePath" || fieldName === "relative_path") {
        pendingPaths.push(value);
      } else if (fieldName) {
        fields[fieldName] = value;
      }
    }

    offset = nextBoundary;
  }

  return { fields, files };
}
