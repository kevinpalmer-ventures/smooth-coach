// Private photo storage in an S3-compatible bucket (Garage in the default deployment).
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const photoTypes = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const typesByExtension = Object.fromEntries(Object.entries(photoTypes).map(([type, extension]) => [extension, type]));
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Identifies the image type from the file's leading bytes; the browser-declared type is not trusted.
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(pngSignature)) return "image/png";
  if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function contentTypeForKey(key) {
  return typesByExtension[key.split(".").pop()] ?? "application/octet-stream";
}

export function describeBucketError(error, bucket) {
  const status = error.$metadata?.httpStatusCode;
  if (status === 404) return `bucket "${bucket}" does not exist`;
  if (status === 403) return "access denied; check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY";
  if (status === 400) return "request rejected; check that S3_REGION matches the storage server's region";
  const code = error.code ?? error.cause?.code;
  if (code) return `cannot reach the storage server (${code}); check S3_ENDPOINT`;
  return `unexpected error (${error.name})`;
}

function failureDetail(error) {
  const status = error.$metadata?.httpStatusCode;
  const code = error.code ?? error.cause?.code;
  return [error.name, status ? `HTTP ${status}` : null, code].filter(Boolean).join(", ");
}

export class PhotoStorageError extends Error {
  constructor(operation, cause) {
    super(`photo storage ${operation} failed (${failureDetail(cause)})`, { cause });
    this.name = "PhotoStorageError";
  }
}

export function createPhotoStorage({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle }) {
  const client = new S3Client({ endpoint, region, forcePathStyle, credentials: { accessKeyId, secretAccessKey } });

  return {
    async checkBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        throw new Error(describeBucketError(error, bucket));
      }
    },
    async putPhoto(key, body, contentType) {
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
      } catch (error) {
        throw new PhotoStorageError("upload", error);
      }
    },
    // Resolves to a readable stream, or null when the object does not exist.
    async getPhotoStream(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return response.Body;
      } catch (error) {
        if (error.name === "NoSuchKey") return null;
        throw new PhotoStorageError("download", error);
      }
    },
    async deletePhoto(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        throw new PhotoStorageError("delete", error);
      }
    },
    destroy() {
      client.destroy();
    }
  };
}
