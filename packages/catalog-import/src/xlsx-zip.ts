/**
 * Hardened ZIP preflight for customer-supplied `.xlsx` archives.
 *
 * SheetJS owns workbook decoding. This module owns the trust boundary that a
 * general workbook parser cannot provide: unique OPC names, declared resource
 * ceilings, supported compression, and a CRC pass over every entry.
 *
 * The limits below are the point of this file. The input is a customer-
 * supplied archive, so every one of them is a hard stop rather than a warning:
 * an archive that needs more than these is not a product export.
 */
import { Buffer } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';

/** An `.xlsx` has on the order of ten parts; hundreds means something else. */
export const MAX_ENTRIES = 512;
/** Largest single part we will decompress. */
export const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
/** Largest total decompressed payload across all parts read. */
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Per-entry compression ratio ceiling — the classic zip-bomb guard. */
export const MAX_COMPRESSION_RATIO = 200;

const SIGNATURE_EOCD = 0x06054b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_ZIP64_LOCATOR = 0x07064b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
/** Sizes live in a trailing data descriptor rather than the local header. */
const FLAG_DATA_DESCRIPTOR = 0x0008;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
}

/** CRC-32 (IEEE 802.3), computed lazily into a 256-entry table on first use. */
let crcTable: Uint32Array | null = null;

function crc32Table(): Uint32Array {
  if (crcTable !== null) return crcTable;
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(bytes: Uint8Array): number {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ (table[((crc ^ (bytes[index] as number)) & 0xff) >>> 0] as number);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Entry names are used only for exact lookups, never to build a filesystem
 * path, but a name carrying a traversal segment or a NUL still signals a
 * hostile or corrupt archive and is refused rather than normalized away.
 */
function assertSafeEntryName(name: string): void {
  if (name === '' || name.length > 512) throw new ZipFormatError('ZIP entry name out of range');
  if (name.includes(String.fromCharCode(0)))
    throw new ZipFormatError('ZIP entry name contains a NUL byte');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new ZipFormatError(`ZIP entry name is absolute: ${name}`);
  }
  if (name.split('/').includes('..')) {
    throw new ZipFormatError(`ZIP entry name escapes the archive: ${name}`);
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const earliest = Math.max(0, bytes.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let offset = bytes.length - EOCD_MIN_SIZE; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === SIGNATURE_EOCD) {
      // Confirm the comment length actually reaches the end of the buffer, so
      // a byte sequence inside compressed data cannot be mistaken for the EOCD.
      const commentLength = bytes.readUInt16LE(offset + 20);
      if (offset + EOCD_MIN_SIZE + commentLength === bytes.length) return offset;
    }
  }
  throw new ZipFormatError('not a ZIP archive: no end-of-central-directory record');
}

/**
 * Read the central directory. Everything the reader needs is here, so the
 * archive is never scanned linearly and a truncated tail cannot be mistaken
 * for a valid entry.
 */
export function readZipDirectory(bytes: Buffer): Map<string, ZipEntry> {
  if (bytes.length < EOCD_MIN_SIZE) throw new ZipFormatError('file is too small to be a ZIP');
  const eocd = findEndOfCentralDirectory(bytes);

  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);

  if (
    totalEntries === 0xffff ||
    directoryOffset === 0xffffffff ||
    directorySize === 0xffffffff ||
    (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === SIGNATURE_ZIP64_LOCATOR)
  ) {
    throw new ZipFormatError('Zip64 archives are not supported');
  }
  if (totalEntries > MAX_ENTRIES) {
    throw new ZipFormatError(`ZIP has ${totalEntries} entries, over the ${MAX_ENTRIES} limit`);
  }
  if (directoryOffset + directorySize > bytes.length) {
    throw new ZipFormatError('ZIP central directory extends past end of file');
  }

  const entries = new Map<string, ZipEntry>();
  const namesByLowerCase = new Map<string, string>();
  let declaredTotal = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== SIGNATURE_CENTRAL) {
      throw new ZipFormatError('ZIP central directory is malformed');
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    if ((flags & FLAG_ENCRYPTED) !== 0) throw new ZipFormatError('encrypted ZIP is not supported');

    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    if (nameStart + nameLength > bytes.length) {
      throw new ZipFormatError('ZIP central directory is truncated');
    }
    const name = bytes.toString('utf8', nameStart, nameStart + nameLength);
    assertSafeEntryName(name);

    if (entries.has(name)) throw new ZipFormatError(`ZIP contains duplicate entry ${name}`);
    const lowerName = name.toLowerCase();
    const caseVariant = namesByLowerCase.get(lowerName);
    if (caseVariant !== undefined) {
      throw new ZipFormatError(
        `ZIP entry names collide by case: ${caseVariant} and ${name}`,
      );
    }

    const compressionMethod = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    if (compressionMethod !== METHOD_STORED && compressionMethod !== METHOD_DEFLATE) {
      throw new ZipFormatError(
        `ZIP entry ${name} uses unsupported compression method ${compressionMethod}`,
      );
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new ZipFormatError(`ZIP entry ${name} declares ${uncompressedSize} bytes`);
    }
    if (
      compressedSize > 0 &&
      uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO
    ) {
      throw new ZipFormatError(`ZIP entry ${name} exceeds the compression-ratio limit`);
    }
    declaredTotal += uncompressedSize;
    if (declaredTotal > MAX_TOTAL_BYTES) {
      throw new ZipFormatError('ZIP decompresses to more than the total byte limit');
    }

    entries.set(name, {
      name,
      compressionMethod,
      crc32: bytes.readUInt32LE(cursor + 16),
      compressedSize,
      uncompressedSize,
      localHeaderOffset: bytes.readUInt32LE(cursor + 42),
    });
    namesByLowerCase.set(lowerName, name);
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  if (cursor !== directoryOffset + directorySize) {
    throw new ZipFormatError('ZIP central-directory size does not match its entries');
  }
  return entries;
}

/** A ZIP archive whose aggregate declaration was validated at construction. */
export class ZipArchive {
  private readonly bytes: Buffer;
  private readonly entries: Map<string, ZipEntry>;

  constructor(bytes: Buffer) {
    this.bytes = bytes;
    this.entries = readZipDirectory(bytes);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  /** Decompressed bytes for one entry, or `null` when the entry is absent. */
  read(name: string): Buffer | null {
    const entry = this.entries.get(name);
    if (entry === undefined) return null;

    const header = entry.localHeaderOffset;
    if (header + 30 > this.bytes.length || this.bytes.readUInt32LE(header) !== SIGNATURE_LOCAL) {
      throw new ZipFormatError(`ZIP entry ${name} has no local header`);
    }
    const flags = this.bytes.readUInt16LE(header + 6);
    if ((flags & FLAG_ENCRYPTED) !== 0) throw new ZipFormatError('encrypted ZIP is not supported');
    const localMethod = this.bytes.readUInt16LE(header + 8);
    if (localMethod !== entry.compressionMethod) {
      throw new ZipFormatError(`ZIP entry ${name} has inconsistent compression methods`);
    }
    const nameLength = this.bytes.readUInt16LE(header + 26);
    const extraLength = this.bytes.readUInt16LE(header + 28);
    const localNameEnd = header + 30 + nameLength;
    if (localNameEnd > this.bytes.length) {
      throw new ZipFormatError(`ZIP entry ${name} has a truncated local name`);
    }
    const localName = this.bytes.toString('utf8', header + 30, localNameEnd);
    if (localName !== name) {
      throw new ZipFormatError(`ZIP entry ${name} has an inconsistent local name`);
    }
    const dataStart = header + 30 + nameLength + extraLength;
    // With a data descriptor the local header's sizes are zero, so the central
    // directory — already validated above — is the only trustworthy source.
    if ((flags & FLAG_DATA_DESCRIPTOR) === 0) {
      const localCompressedSize = this.bytes.readUInt32LE(header + 18);
      const localUncompressedSize = this.bytes.readUInt32LE(header + 22);
      if (
        localCompressedSize !== entry.compressedSize ||
        localUncompressedSize !== entry.uncompressedSize
      ) {
        throw new ZipFormatError(`ZIP entry ${name} has inconsistent local metadata`);
      }
    }
    const compressedSize = entry.compressedSize;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > this.bytes.length) throw new ZipFormatError(`ZIP entry ${name} is truncated`);
    const raw = this.bytes.subarray(dataStart, dataEnd);

    let output: Buffer;
    if (entry.compressionMethod === METHOD_STORED) {
      output = Buffer.from(raw);
    } else if (entry.compressionMethod === METHOD_DEFLATE) {
      try {
        output = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch {
        throw new ZipFormatError(`ZIP entry ${name} could not be decompressed`);
      }
    } else {
      throw new ZipFormatError(
        `ZIP entry ${name} uses unsupported compression method ${entry.compressionMethod}`,
      );
    }

    if (output.length !== entry.uncompressedSize) {
      throw new ZipFormatError(`ZIP entry ${name} size does not match the directory`);
    }
    if (crc32(output) !== entry.crc32) {
      throw new ZipFormatError(`ZIP entry ${name} failed its CRC check`);
    }

    return output;
  }

  /**
   * Inflate and CRC-check every entry before a general workbook parser sees
   * the original archive. The visitor is used by OOXML preflight to scan every
   * XML and relationship part, including parts the selected sheet never uses.
   */
  verifyAllEntries(visitor?: (name: string, bytes: Buffer) => void): void {
    for (const name of this.entries.keys()) {
      const bytes = this.read(name);
      if (bytes === null) throw new ZipFormatError(`ZIP entry ${name} disappeared`);
      visitor?.(name, bytes);
    }
  }

  /** Decompressed entry decoded as UTF-8, or `null` when absent. */
  readText(name: string): string | null {
    const bytes = this.read(name);
    return bytes === null ? null : bytes.toString('utf8');
  }
}

/** True when the bytes begin with a ZIP local-file-header signature. */
export function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === SIGNATURE_LOCAL;
}
