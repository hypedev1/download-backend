import pg from "pg";
import { config } from "./config.js";
import { logger } from "./logger.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

if (config.DATABASE_URL) {
  logger.info("Initializing Postgres pool...");
  pool = new Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_URL.includes("localhost") || config.DATABASE_URL.includes("127.0.0.1") 
      ? false 
      : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 10000,
  });
} else {
  logger.warn("DATABASE_URL is not set. Database records will not be stored.");
}

export async function query(sql: string, params?: any[]) {
  if (!pool) {
    logger.warn(`Database not connected. Skipping query: ${sql.slice(0, 100)}...`);
    return { rows: [] };
  }
  return await pool.query(sql, params);
}

export async function logDownload(userId: string, platform: string, title: string, thumbnail: string | null, url: string, format: string) {
  try {
    await query(
      `INSERT INTO public.downloads (user_id, platform, title, thumbnail, url, format, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed')`,
      [userId, platform, title || "Untitled Media", thumbnail || null, url, format]
    );
    logger.info(`Recorded download for user ${userId} on platform ${platform}`);
  } catch (err: any) {
    logger.error("Failed to log download to database:", err);
  }
}

export async function incrementPlatformUsage(userId: string, platform: string) {
  try {
    await query(
      `INSERT INTO public.user_platform_usage (user_id, platform, used_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (user_id, platform, period_start)
       DO UPDATE SET used_count = public.user_platform_usage.used_count + 1`,
      [userId, platform]
    );
    logger.info(`Incremented platform usage for user ${userId} on ${platform}`);
  } catch (err: any) {
    logger.error("Failed to increment platform usage in database:", err);
  }
}
