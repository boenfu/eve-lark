import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { LarkDecryptError } from "./errors.js";

/**
 * Verify an `X-Lark-Signature` header against the raw webhook body.
 *
 * Feishu computes: `sha256(timestamp + nonce + encrypt_key + body)` and ships
 * the hex digest (optionally prefixed with `sha256=`) in `X-Lark-Signature`.
 * We concatenate the string parts first, then the raw bytes of the body, to
 * avoid a UTF-8 round-trip on the request body.
 *
 * Constant-time compare. Returns false on length mismatch instead of throwing.
 */
export function verifySignature(opts: {
  timestamp: string;
  nonce: string;
  encryptKey: string;
  rawBody: Buffer;
  signatureHeader: string;
}): boolean {
  const expected = opts.signatureHeader.replace(/^sha256=/, "");
  const computed = createHash("sha256")
    .update(opts.timestamp + opts.nonce + opts.encryptKey)
    .update(opts.rawBody)
    .digest("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Decrypt the `encrypt` field from a Feishu webhook body.
 *
 * Layout:
 *   key = SHA256(encrypt_key)              // 32 bytes → AES-256
 *   buf = base64decode(encrypt_field)
 *   iv  = buf[0:16]
 *   ct  = buf[16:]                        // AES-256-CBC ciphertext
 *   plaintext = AES_256_CBC_decrypt(key, iv, ct)  // PKCS#7 unpadded
 *
 * Returns the raw plaintext bytes. The caller is expected to JSON.parse them.
 */
export function decryptPayload(encryptB64: string, encryptKey: string): Buffer {
  const key = createHash("sha256").update(encryptKey).digest();
  const buf = Buffer.from(encryptB64, "base64");

  if (buf.length < 32) {
    throw new LarkDecryptError(
      `eve-lark: ciphertext too short (${buf.length} bytes; need >= 32 for IV + one block)`,
    );
  }
  if ((buf.length - 16) % 16 !== 0) {
    throw new LarkDecryptError(
      `eve-lark: ciphertext length ${buf.length} is not 16 + N*16`,
    );
  }

  const iv = buf.subarray(0, 16);
  const ct = buf.subarray(16);
  const dec = createDecipheriv("aes-256-cbc", key, iv);

  try {
    return Buffer.concat([dec.update(ct), dec.final()]);
  } catch (e) {
    throw new LarkDecryptError("eve-lark: AES decrypt failed (bad padding or wrong key)", {
      cause: e,
    });
  }
}
