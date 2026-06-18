import { createCipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Test-only helper that encrypts a payload the way Feishu does, so the decrypt
 * path can be exercised against a known-good ciphertext.
 *
 * Mirror of src/crypto.ts:decryptPayload:
 *   key = SHA256(encryptKey)
 *   buf = iv(16) || AES-256-CBC(key, iv, pkcs7(plaintext))
 */
export function createCipher(plaintext: Buffer, encryptKey: string): Buffer {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final()]);
}
