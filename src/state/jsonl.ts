import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Appends to a regular file with O_APPEND are only guaranteed not to interleave
// below this size (see docs/CONTRACTS.md).
export const MAX_LINE_BYTES = 4096;

export function appendJsonLine(path: string, value: unknown, what: string): void {
  const line = JSON.stringify(value) + "\n";
  const size = Buffer.byteLength(line);
  if (size > MAX_LINE_BYTES) {
    throw new Error(`${what} is ${size} bytes, over the ${MAX_LINE_BYTES} byte line limit: put big payloads in a file and reference it`);
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line);
}

export interface JsonLine {
  value: unknown;
  end: number; // byte offset just after this line's newline
}

// Reads the complete lines after `offset` (a byte offset). A last line without its
// newline is a write in progress (or a crash mid-write) and is left for later.
// Lines that aren't valid JSON are skipped.
export function readJsonLinesFrom(path: string, offset: number): { lines: JsonLine[]; offset: number } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { lines: [], offset };
    }
    throw e;
  }
  let buf: Buffer;
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) {
      return { lines: [], offset };
    }
    buf = Buffer.alloc(size - offset);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    buf = buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
  const lines: JsonLine[] = [];
  let start = 0;
  for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a, start)) {
    const text = buf.toString("utf8", start, nl);
    start = nl + 1;
    if (text.trim() === "") continue;
    try {
      lines.push({ value: JSON.parse(text), end: offset + start });
    } catch {
      // A corrupt line can't be repaired by waiting; skip it rather than block the file.
    }
  }
  return { lines, offset: offset + start };
}

export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// Ids end up in paths under the state directory.
export function checkId(id: string, what: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`invalid ${what}: ${JSON.stringify(id)}`);
  }
}
