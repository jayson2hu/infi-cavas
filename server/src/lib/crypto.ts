import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../env";
import { ApiError, invariant } from "./errors";

const encryptionKey = (secret: string) => createHash("sha256").update(secret).digest();

export function encryptSecret(plaintext: string, secret = env.APP_SECRET) {
  invariant(plaintext.length > 0 && secret.length >= 32, 422, "invalid_secret", "密钥配置不合法");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function decryptSecret(ciphertext: string, secret = env.APP_SECRET) {
  try {
    const bytes = Buffer.from(ciphertext, "base64");
    if (secret.length < 32 || bytes.length < 29 || bytes.toString("base64") !== ciphertext) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new ApiError(500, "secret_decryption_failed", "供应商密钥无法解密，请重新保存配置");
  }
}
