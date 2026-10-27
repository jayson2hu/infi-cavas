import { expect, test } from "bun:test";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";

const secret = "test-master-secret-with-at-least-32-characters";
const key = "test-provider-sensitive-value-8362";

test("AES-256-GCM 可解密且相同 Key 每次保存均使用新 IV", () => {
  const first = encryptSecret(key, secret);
  const second = encryptSecret(key, secret);
  expect(first).not.toBe(second);
  expect(first).not.toContain(key);
  expect(decryptSecret(first, secret)).toBe(key);
  expect(decryptSecret(second, secret)).toBe(key);
  expect(Buffer.from(first, "base64").length).toBe(12 + 16 + Buffer.byteLength(key));
});

test("认证标签、密文或主密钥篡改后失败且错误不暴露秘密", () => {
  const ciphertext = encryptSecret(key, secret);
  for (const offset of [0, 12, 28]) {
    const tampered = Buffer.from(ciphertext, "base64");
    tampered[offset] ^= 1;
    expect(() => decryptSecret(tampered.toString("base64"), secret)).toThrow("供应商密钥无法解密");
  }
  expect(() => decryptSecret(ciphertext, `${secret}-wrong`)).toThrow("供应商密钥无法解密");
  expect(() => decryptSecret("invalid", secret)).toThrow("供应商密钥无法解密");
});
