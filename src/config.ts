import dotenv from "dotenv";
import { z } from "zod";
import * as path from "node:path";

// Load environment variables from .env file (if exists)
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().optional(),
  BACKEND_API_KEY: z.string().default("dev-secret-key"),
  
  // Optional Cloudflare R2 configurations
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(),
});

export const config = configSchema.parse(process.env);
