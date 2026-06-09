import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";

const TEMP_DOWNLOAD_DIR = path.resolve("./downloads-temp");
if (!fs.existsSync(TEMP_DOWNLOAD_DIR)) {
  fs.mkdirSync(TEMP_DOWNLOAD_DIR, { recursive: true });
}

let s3Client: S3Client | null = null;
const isR2Configured = !!(
  config.R2_ENDPOINT &&
  config.R2_ACCESS_KEY_ID &&
  config.R2_SECRET_ACCESS_KEY &&
  config.R2_BUCKET_NAME
);

if (isR2Configured) {
  logger.info("Initializing Cloudflare R2 client...");
  s3Client = new S3Client({
    endpoint: config.R2_ENDPOINT,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID!,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
    },
    region: "auto",
  });
} else {
  logger.info("Cloudflare R2 is not configured. Falling back to local VPS file storage.");
}

export interface UploadResult {
  url: string;
  isR2: boolean;
  key?: string;
}

export async function storeFile(filePath: string, filename: string): Promise<UploadResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  if (s3Client && isR2Configured) {
    const key = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}_${filename}`;
    logger.info(`Uploading file ${filename} to Cloudflare R2 with key ${key}...`);

    try {
      const fileBuffer = fs.readFileSync(filePath);
      const contentType = filename.endsWith(".mp3")
        ? "audio/mpeg"
        : filename.endsWith(".jpg") || filename.endsWith(".jpeg")
        ? "image/jpeg"
        : "video/mp4";

      await s3Client.send(
        new PutObjectCommand({
          Bucket: config.R2_BUCKET_NAME,
          Key: key,
          Body: fileBuffer,
          ContentType: contentType,
        })
      );

      // Clean up the local file after uploading to R2
      try {
        fs.unlinkSync(filePath);
        logger.info(`Cleaned up local file after R2 upload: ${filePath}`);
      } catch (err) {
        logger.error(`Failed to delete local file after R2 upload: ${filePath}`, err);
      }

      const publicUrlBase = config.R2_PUBLIC_URL || `${config.R2_ENDPOINT}/${config.R2_BUCKET_NAME}`;
      const url = `${publicUrlBase.replace(/\/$/, "")}/${key}`;
      logger.info(`Successfully uploaded to R2: ${url}`);
      return { url, isR2: true, key };
    } catch (err: any) {
      logger.error(`R2 upload failed: ${err.message}. Falling back to local storage.`);
    }
  }

  // Fallback to local storage (file remains in local path, return indicator)
  return {
    url: `/file/${path.basename(filePath)}`, // routes to Fastify server file download endpoint
    isR2: false,
  };
}

export function getTempDir(): string {
  return TEMP_DOWNLOAD_DIR;
}
