/**
 * Content-hash fallback identity (PLAN.md: SQLite keyed by MediaStore id,
 * content hash as fallback). Computed lazily and best-effort — only for
 * photos that get staged for culling, so a 200-photo day never pays for
 * 200 full-file reads.
 */
import { File } from 'expo-file-system';
import * as Crypto from 'expo-crypto';

/** SHA-256 hex of a file's bytes, or null if the file can't be read. */
export async function sha256OfFile(uri: string): Promise<string | null> {
  try {
    const bytes = await new File(uri).bytes();
    const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** File size in bytes, 0 when unknown/unreadable — used for the summary's
 * "approximate storage reclaimed". */
export function fileSize(uri: string): number {
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}
