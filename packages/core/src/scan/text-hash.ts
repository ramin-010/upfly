import { createHash } from 'node:crypto';

/** The digest `hashText` uses unless it is told otherwise. */
export const TEXT_HASH_ALGORITHM = 'sha256';

/**
 * Hash a text as the UTF-8 bytes it encodes to.
 *
 * For a file that is valid UTF-8 this equals the hash of the file's bytes. For any other
 * file the two differ, because decoding put U+FFFD in place of the bytes that were not
 * UTF-8 and encoding cannot bring them back.
 *
 * @param text the text as read
 * @param algorithm a digest `node:crypto` knows, such as a store's `hashAlgorithm`
 * @returns the digest, in hexadecimal
 */
export function hashText(text: string, algorithm: string = TEXT_HASH_ALGORITHM): string {
  return createHash(algorithm).update(text, 'utf8').digest('hex');
}
