import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { test } from "node:test";
import { createJob, getJob } from "./convert/store.js";
import { runPipeline } from "./convert/pipeline.js";

interface ZipEntryInput {
  name: string;
  content: Buffer;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = zlib.deflateRawSync(entry.content);
    const checksum = crc32(entry.content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(Buffer.concat([localHeader, name, compressed]));

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([centralHeader, name]));

    offset += 30 + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}

async function runRejectedZip(jobId: string, zip: Buffer): Promise<string> {
  const zipPath = path.join(os.tmpdir(), `${jobId}.zip`);
  const workDir = path.join(os.tmpdir(), `rtl-${jobId}`);
  fs.writeFileSync(zipPath, zip);
  createJob(jobId);

  await runPipeline(jobId, zipPath);

  const job = getJob(jobId);
  assert.equal(job?.status, "error");
  assert.equal(fs.existsSync(workDir), false);
  assert.equal(fs.existsSync(zipPath), false);
  return job?.logs.at(-1)?.message ?? "";
}

test("rejects a zip bomb before extracting any files", async () => {
  const message = await runRejectedZip(
    "security-zip-bomb-test",
    createZip([
      {
        name: "repeated.txt",
        content: Buffer.alloc(1024 * 1024, "A"),
      },
    ]),
  );

  assert.match(message, /suspicious compression ratio/i);
});

test("rejects a path traversal entry before extracting any files", async () => {
  const message = await runRejectedZip(
    "security-zip-slip-test",
    createZip([
      {
        name: "../../../evil.txt",
        content: Buffer.from("must not be written"),
      },
    ]),
  );

  assert.match(message, /unsafe entry path/i);
});