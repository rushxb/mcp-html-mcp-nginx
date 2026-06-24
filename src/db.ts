import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// ---- Data types ----

export interface SiteRecord {
  /** Unique short identifier, e.g. "a3xK9m". */
  siteId: string;
  /** Human-readable name given by the caller (or auto-generated). */
  name: string;
  /** Absolute path to the site root on disk. */
  dir: string;
  /** Full public URL to access the site. */
  url: string;
  /** Number of files stored. */
  filesCount: number;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
  /** ISO-8601 expiration timestamp (optional). */
  expiresAt?: string;
  /** Whether the site is a single-page application that may need index.html fallback routing. */
  spa?: boolean;
}

interface DbData {
  sites: SiteRecord[];
}

// ---- Lightweight JSON file database ----

export class SiteDb {
  private data: DbData;

  constructor(private readonly filePath: string) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (existsSync(filePath)) {
      this.data = JSON.parse(readFileSync(filePath, "utf-8")) as DbData;
    } else {
      this.data = { sites: [] };
      this.flush();
    }
  }

  /** Persist current state to disk. */
  private flush(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  /** Add a new site record. */
  add(record: SiteRecord): void {
    this.data.sites.push(record);
    this.flush();
  }

  /** Find a site by its ID. */
  findById(siteId: string): SiteRecord | undefined {
    return this.data.sites.find((s) => s.siteId === siteId);
  }

  /** Return all site records. */
  list(): SiteRecord[] {
    return [...this.data.sites];
  }

  /** Update an existing record in-place. */
  update(siteId: string, patch: Partial<Omit<SiteRecord, "siteId">>): SiteRecord | undefined {
    const record = this.data.sites.find((s) => s.siteId === siteId);
    if (!record) return undefined;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    this.flush();
    return record;
  }

  /** Remove a site record by ID and return it. */
  remove(siteId: string): SiteRecord | undefined {
    const idx = this.data.sites.findIndex((s) => s.siteId === siteId);
    if (idx === -1) return undefined;
    const [removed] = this.data.sites.splice(idx, 1);
    this.flush();
    return removed;
  }
}
