// @ts-nocheck
/**
 * Hamilton County TN bulk-dataset IO.
 *
 * Hamilton County / Chattanooga publish their biggest lead sources as whole-file
 * downloads rather than row-queryable APIs, so this module exists to read those
 * files without holding them in memory:
 *
 *   - Trustee delinquent tax file  — 3.7 MB ZIP → 29 MB CSV  (fetchZipCsv)
 *   - ChattaData open-data exports — up to 82 MB raw CSV      (streamCsvRows)
 *
 * streamCsvRows parses off the response stream and hands each row to a callback,
 * so peak memory is one chunk regardless of file size. Buffering an 82 MB code
 * enforcement export as a string would cost ~165 MB with the decompressed copy —
 * enough to matter on a Railway dyno running several scrapers at once.
 *
 * Node has no built-in ZIP reader (zlib does gzip/deflate, not the archive
 * container), so unzipCsvEntry walks the central directory itself. That is ~40
 * lines and keeps the dependency list unchanged.
 */

import { inflateRawSync } from "zlib";
import { fetchWithRetry } from "./base.js";
import { logger } from "../utils/logger.js";

/** Row callback. Return `false` to stop parsing early (e.g. once past a date window). */
export type CsvRowFn = (row: string[], index: number) => void | boolean;

/**
 * Incremental RFC-4180 CSV parser. Fed arbitrary chunk boundaries — including a
 * boundary that lands between a quote and its escape partner, which is why the
 * pending-quote state is carried across push() calls.
 */
export class CsvStreamParser {
  private inQuotes = false;
  private pendingQuote = false;
  private field = "";
  private row: string[] = [];
  private fieldStart = true;
  private index = 0;
  private stopped = false;

  constructor(private readonly onRow: CsvRowFn) {}

  get done(): boolean {
    return this.stopped;
  }

  push(chunk: string): void {
    if (this.stopped || !chunk) return;

    // A '"' that ended the previous chunk while inside quotes is ambiguous: it is
    // either an escaped quote (next char is '"') or the closing quote. Resolve now.
    if (this.pendingQuote) {
      this.pendingQuote = false;
      if (chunk[0] === '"') {
        this.field += '"';
        chunk = chunk.slice(1);
      } else {
        this.inQuotes = false;
      }
      if (!chunk) return;
    }

    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];

      if (this.inQuotes) {
        if (c !== '"') {
          this.field += c;
          continue;
        }
        if (i === chunk.length - 1) {
          this.pendingQuote = true;
          return;
        }
        if (chunk[i + 1] === '"') {
          this.field += '"';
          i++;
        } else {
          this.inQuotes = false;
        }
        continue;
      }

      if (c === '"' && this.fieldStart) {
        this.inQuotes = true;
        this.fieldStart = false;
      } else if (c === ",") {
        this.endField();
      } else if (c === "\n") {
        this.endField();
        this.endRow();
        if (this.stopped) return;
      } else if (c !== "\r") {
        this.field += c;
        this.fieldStart = false;
      }
    }
  }

  /** Flush the trailing row (files often lack a final newline). */
  end(): void {
    if (this.stopped) return;
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.inQuotes = false;
    }
    if (this.field || this.row.length) {
      this.endField();
      this.endRow();
    }
  }

  private endField(): void {
    this.row.push(this.field);
    this.field = "";
    this.fieldStart = true;
  }

  private endRow(): void {
    const row = this.row;
    this.row = [];
    // Skip blank lines produced by trailing newlines.
    if (row.length === 1 && row[0] === "") return;
    if (this.onRow(row, this.index++) === false) this.stopped = true;
  }
}

/** Parse an already-in-memory CSV string/buffer row by row. */
export function parseCsvText(text: string, onRow: CsvRowFn): void {
  const parser = new CsvStreamParser(onRow);
  parser.push(text);
  parser.end();
}

/**
 * Fetch a CSV over HTTP and parse it off the response stream.
 * Returns the number of rows seen (header included) so callers can tell an empty
 * file apart from a fetch that silently produced nothing.
 */
export async function streamCsvRows(url: string, onRow: CsvRowFn): Promise<number> {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`CSV fetch failed (${res.status}): ${url}`);
  if (!res.body) {
    const text = await res.text();
    let n = 0;
    parseCsvText(text, (row, i) => {
      n++;
      return onRow(row, i);
    });
    return n;
  }

  const decoder = new TextDecoder("utf-8");
  let count = 0;
  const parser = new CsvStreamParser((row, i) => {
    count++;
    return onRow(row, i);
  });

  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    parser.push(decoder.decode(chunk, { stream: true }));
    if (parser.done) return count;
  }
  parser.push(decoder.decode());
  parser.end();
  return count;
}

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * Extract the first entry whose name matches `match` (default: any .csv) from a
 * ZIP buffer. Walks the central directory rather than scanning local headers,
 * because entries written with a data descriptor carry zeroed sizes in the local
 * header — the county's Trustee export does exactly that on some refreshes.
 */
export function unzipCsvEntry(buf: Buffer, match = /\.csv$/i): string {
  // The EOCD sits at the end, after a variable-length comment (max 65535).
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP: end-of-central-directory record not found");

  const entries = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let e = 0; e < entries; e++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CDIR_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("latin1", ptr + 46, ptr + 46 + nameLen);

    if (match.test(name)) {
      if (buf.readUInt32LE(localOff) !== LOCAL_SIG) {
        throw new Error(`ZIP: bad local header for ${name}`);
      }
      // Local header's own name/extra lengths are authoritative for the data offset.
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return data.toString("utf8");
      if (method === 8) return inflateRawSync(data).toString("utf8");
      throw new Error(`ZIP: unsupported compression method ${method} for ${name}`);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ZIP: no entry matching ${match} found`);
}

/** Download a ZIP and return its first CSV entry as text. */
export async function fetchZipCsv(url: string, match?: RegExp): Promise<string> {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`ZIP fetch failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 22) throw new Error(`ZIP fetch returned ${buf.length} bytes: ${url}`);
  logger.debug({ url, bytes: buf.length }, "[TN] zip downloaded");
  return unzipCsvEntry(buf, match);
}

/**
 * Build a case-insensitive header → index resolver.
 * Hamilton's Trustee export has several columns literally named "Filler", so the
 * first occurrence wins and callers that need a duplicate name use a raw index.
 */
export function headerIndex(header: string[]): (name: string) => number {
  const map = new Map<string, number>();
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, i);
  });
  return (name: string) => map.get(name.trim().toLowerCase()) ?? -1;
}

/** ArcGIS Online hosted-CSV item → its raw data URL. */
export function arcgisItemCsvUrl(itemId: string): string {
  return `https://www.arcgis.com/sharing/rest/content/items/${itemId}/data`;
}
