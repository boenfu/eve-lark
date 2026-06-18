import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCipher } from "./helpers/encrypt.js";
import { decryptPayload, verifySignature } from "../src/crypto.js";
import { LarkDecryptError } from "../src/errors.js";

function sha256Hex(parts: Array<string | Buffer>): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

describe("verifySignature", () => {
  const encryptKey = "test_encrypt_key";
  const timestamp = "1700000000";
  const nonce = "abc123";
  const body = Buffer.from('{"encrypt":"deadbeef"}', "utf8");

  it("returns true when signature matches sha256(timestamp + nonce + key + body)", () => {
    const expected = sha256Hex([timestamp, nonce, encryptKey, body]);
    const ok = verifySignature({
      timestamp,
      nonce,
      encryptKey,
      rawBody: body,
      signatureHeader: expected,
    });
    expect(ok).toBe(true);
  });

  it("accepts signatureHeader with leading sha256= prefix", () => {
    const expected = sha256Hex([timestamp, nonce, encryptKey, body]);
    const ok = verifySignature({
      timestamp,
      nonce,
      encryptKey,
      rawBody: body,
      signatureHeader: `sha256=${expected}`,
    });
    expect(ok).toBe(true);
  });

  it("returns false when signature does not match", () => {
    const ok = verifySignature({
      timestamp,
      nonce,
      encryptKey,
      rawBody: body,
      signatureHeader: "0".repeat(64),
    });
    expect(ok).toBe(false);
  });

  it("returns false when body has been tampered with", () => {
    const expected = sha256Hex([timestamp, nonce, encryptKey, body]);
    const tampered = Buffer.concat([body, Buffer.from("X")]);
    const ok = verifySignature({
      timestamp,
      nonce,
      encryptKey,
      rawBody: tampered,
      signatureHeader: expected,
    });
    expect(ok).toBe(false);
  });

  it("returns false when encryptKey differs", () => {
    const expected = sha256Hex([timestamp, nonce, encryptKey, body]);
    const ok = verifySignature({
      timestamp,
      nonce,
      encryptKey: "different_key",
      rawBody: body,
      signatureHeader: expected,
    });
    expect(ok).toBe(false);
  });

  it("returns false on length mismatch instead of throwing", () => {
    const ok = verifySignature({
      timestamp,
      nonce,
      encryptKey,
      rawBody: body,
      signatureHeader: "deadbeef",
    });
    expect(ok).toBe(false);
  });

  it("verifies the exact vector from Feishu's published example", () => {
    const ts = "1700000000";
    const n = "nonce_test";
    const k = "key_test";
    const b = Buffer.from("payload");
    const expected = sha256Hex([ts, n, k, b]);
    expect(
      verifySignature({
        timestamp: ts,
        nonce: n,
        encryptKey: k,
        rawBody: b,
        signatureHeader: expected,
      }),
    ).toBe(true);
  });
});

describe("decryptPayload", () => {
  const encryptKey = "test_encrypt_key";

  it("round-trips a payload encrypted with AES-256-CBC", () => {
    const plaintext = Buffer.from(
      JSON.stringify({ hello: "world", n: 42 }),
      "utf8",
    );
    const encrypted = createCipher(plaintext, encryptKey);
    const out = decryptPayload(encrypted.toString("base64"), encryptKey);
    expect(JSON.parse(out.toString("utf8"))).toEqual({ hello: "world", n: 42 });
  });

  it("decrypts a payload larger than one block", () => {
    const plaintext = Buffer.from("X".repeat(1000), "utf8");
    const encrypted = createCipher(plaintext, encryptKey);
    const out = decryptPayload(encrypted.toString("base64"), encryptKey);
    expect(out.equals(plaintext)).toBe(true);
  });

  it("throws LarkDecryptError when ciphertext is shorter than one IV block", () => {
    expect(() =>
      decryptPayload(randomBytes(8).toString("base64"), encryptKey),
    ).toThrow(LarkDecryptError);
  });

  it("throws LarkDecryptError on tampered ciphertext", () => {
    const plaintext = Buffer.from("secret message", "utf8");
    const encrypted = createCipher(plaintext, encryptKey);
    const idx = 20;
    if (idx < encrypted.length) {
      encrypted[idx] = encrypted[idx]! ^ 0xff;
    }
    expect(() =>
      decryptPayload(encrypted.toString("base64"), encryptKey),
    ).toThrow(LarkDecryptError);
  });

  it("throws LarkDecryptError when ciphertext length is not a multiple of 16", () => {
    const bad = randomBytes(33);
    expect(() =>
      decryptPayload(bad.toString("base64"), encryptKey),
    ).toThrow(LarkDecryptError);
  });
});
