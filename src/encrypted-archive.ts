import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

const deriveKey = promisify(scrypt);
const compress = promisify(gzip);
const decompress = promisify(gunzip);
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export async function sealArchive(plain: Buffer, passphrase: string, magic: Buffer): Promise<Buffer> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt, 32) as Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(magic);
    const encrypted = cipher.update(await compress(plain));
    const final = cipher.final();
    return Buffer.concat([magic, salt, iv, cipher.getAuthTag(), encrypted, final]);
  } finally { key.fill(0); }
}

export function isArchive(data: Buffer, magic: Buffer, maxBytes: number): boolean {
  const headerBytes = magic.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
  return data.length > headerBytes && data.length <= maxBytes && data.subarray(0, magic.length).equals(magic);
}

export async function openArchive(data: Buffer, passphrase: string, magic: Buffer, maxBytes: number): Promise<Buffer> {
  if (!isArchive(data, magic, maxBytes)) throw new Error("Invalid encrypted archive");
  const saltEnd = magic.length + SALT_BYTES;
  const ivEnd = saltEnd + IV_BYTES;
  const headerEnd = ivEnd + TAG_BYTES;
  const key = await deriveKey(passphrase, data.subarray(magic.length, saltEnd), 32) as Buffer;
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(saltEnd, ivEnd));
    cipher.setAAD(magic);
    cipher.setAuthTag(data.subarray(ivEnd, headerEnd));
    const compressed = Buffer.concat([cipher.update(data.subarray(headerEnd)), cipher.final()]);
    return await decompress(compressed, { maxOutputLength: maxBytes });
  } finally { key.fill(0); }
}
