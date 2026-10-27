import { nanoid } from "nanoid";
import { createHash, randomBytes } from "node:crypto";

export const id = (prefix: string) => `${prefix}_${nanoid()}`;
export const randomToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
