import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutBucketCorsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";
import { invariant } from "./errors";

const options = { region: env.S3_REGION, forcePathStyle: env.S3_FORCE_PATH_STYLE, credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } };
export const s3 = new S3Client({ ...options, endpoint: env.S3_ENDPOINT });
const publicS3 = new S3Client({ ...options, endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT, requestChecksumCalculation: "WHEN_REQUIRED" });
export const fileUrl = (objectKey: string) => `/api/files/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
export function assertWorkspaceObject(objectKey: string, workspaceId: string) {
  invariant(objectKey.startsWith(`ws/${workspaceId}/`) && !objectKey.split("/").some((part) => !part || part === "." || part === "..") && !/[\\\u0000-\u001f]/.test(objectKey), 403, "file_forbidden", "无权访问此文件");
}
export async function ensureBucket() {
  try { await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET })); }
  catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
    try { await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET })); }
    catch (creationError) {
      if ((creationError as { name?: string }).name !== "BucketAlreadyOwnedByYou") throw creationError;
      await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    }
  }
  await s3.send(new PutBucketCorsCommand({ Bucket: env.S3_BUCKET, CORSConfiguration: { CORSRules: [{ AllowedOrigins: [new URL(env.APP_ORIGIN).origin], AllowedMethods: ["GET", "PUT", "HEAD"], AllowedHeaders: ["content-type", "content-length", "x-amz-*"], ExposeHeaders: ["ETag"] }] } }));
}
export const headObject = (objectKey: string) => s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }));
export const deleteObject = (objectKey: string) => s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }));
export const signGet = (objectKey: string) => getSignedUrl(publicS3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }), { expiresIn: 600 });
export const signPut = (objectKey: string, mimeType: string, bytes: number, metadata: Record<string, string> = {}) => getSignedUrl(publicS3, new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey, ContentType: mimeType, ContentLength: bytes, Metadata: metadata }), { expiresIn: 300, signableHeaders: new Set(["content-type"]), unhoistableHeaders: new Set(Object.keys(metadata).map((key) => `x-amz-meta-${key}`)) });
export async function readObject(objectKey: string) {
  const value = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }));
  return { bytes: await value.Body!.transformToByteArray(), mimeType: value.ContentType ?? "application/octet-stream" };
}
export async function putObject(objectKey: string, bytes: Uint8Array, mimeType: string) {
  await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey, Body: bytes, ContentType: mimeType, ContentLength: bytes.byteLength }));
}
export async function* listObjectKeys(prefix: string) {
  let ContinuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: env.S3_BUCKET, Prefix: prefix, ContinuationToken }));
    for (const object of page.Contents ?? []) if (object.Key) yield object.Key;
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
}
