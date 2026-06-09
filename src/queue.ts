import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { downloadMediaStream } from "./yt-dlp.js";
import { storeFile, getTempDir } from "./storage.js";
import { logDownload, incrementPlatformUsage } from "./db.js";
import { logger } from "./logger.js";

export interface Job {
  id: string;
  url: string;
  format: "mp4" | "mp3" | "thumbnail";
  quality?: string;
  title: string;
  thumbnail?: string;
  userId: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  statusText: string;
  error?: string;
  filePath?: string;
  fileName?: string;
  downloadUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

class JobQueue {
  private jobs = new Map<string, Job>();
  private activeCount = 0;
  private maxConcurrency = 3;
  private queue: string[] = [];

  constructor() {
    // Start temporary files cleanup worker
    this.startCleanupWorker();
  }

  public createJob(options: {
    url: string;
    format: "mp4" | "mp3" | "thumbnail";
    quality?: string;
    title: string;
    thumbnail?: string;
    userId: string;
  }): Job {
    const job: Job = {
      id: randomUUID(),
      url: options.url,
      format: options.format,
      quality: options.quality,
      title: options.title,
      thumbnail: options.thumbnail,
      userId: options.userId,
      status: "pending",
      progress: 0,
      statusText: "Queued in background",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    logger.info(`Job created: ${job.id} for URL: ${job.url}`);

    this.processNext();
    return job;
  }

  public getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  private async processNext() {
    if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const jobId = this.queue.shift();
    if (!jobId) return;

    const job = this.jobs.get(jobId);
    if (!job) return;

    this.activeCount++;
    logger.info(`Starting job execution: ${job.id}`);
    
    // Execute job with retry wrapper
    this.executeWithRetry(job, 2)
      .then(() => {
        logger.info(`Job completed successfully: ${job.id}`);
      })
      .catch((err) => {
        logger.error(`Job failed after retries: ${job.id}. Error: ${err.message}`);
      })
      .finally(() => {
        this.activeCount--;
        this.processNext();
      });
  }

  private async executeWithRetry(job: Job, retriesLeft: number): Promise<void> {
    job.status = "processing";
    job.updatedAt = new Date();

    try {
      // 1. Download media file
      const ext = job.format === "mp3" ? "mp3" : job.format === "thumbnail" ? "jpg" : "mp4";
      const sanitizedTitle = (job.title || "download")
        .replace(/[^a-z0-9]/gi, "_")
        .toLowerCase()
        .slice(0, 50);
      const filename = `${sanitizedTitle}.${ext}`;
      const tempPath = path.join(getTempDir(), `${job.id}.${ext}`);

      logger.info(`Downloading media for job ${job.id} to ${tempPath}...`);
      await downloadMediaStream(
        job.url,
        job.format,
        job.quality,
        tempPath,
        (progress, statusText) => {
          job.progress = progress;
          job.statusText = statusText;
          job.updatedAt = new Date();
        }
      );

      // 2. Upload file to R2 or serve locally
      logger.info(`Storing completed media for job ${job.id}...`);
      job.statusText = "Saving file...";
      const storageResult = await storeFile(tempPath, filename);

      job.filePath = tempPath; // local path (might be deleted if R2, storeFile handles deletion)
      job.fileName = filename;
      job.downloadUrl = storageResult.url;
      job.status = "completed";
      job.progress = 100;
      job.statusText = "Completed";
      job.updatedAt = new Date();

      // 3. Log download history & usage to Supabase Postgres database
      logger.info(`Logging job data to DB: ${job.id}`);
      
      // Extract platform name from url
      let platform = "other";
      try {
        const hostname = new URL(job.url).hostname.toLowerCase();
        if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) platform = "youtube";
        else if (hostname.includes("tiktok.com")) platform = "tiktok";
        else if (hostname.includes("instagram.com")) platform = "instagram";
        else if (hostname.includes("twitter.com") || hostname.includes("x.com")) platform = "twitter";
        else if (hostname.includes("facebook.com")) platform = "facebook";
        else if (hostname.includes("pinterest.com")) platform = "pinterest";
        else if (hostname.includes("reddit.com")) platform = "reddit";
        else if (hostname.includes("vimeo.com")) platform = "vimeo";
        else if (hostname.includes("dailymotion.com")) platform = "dailymotion";
        else if (hostname.includes("telegram.org") || hostname.includes("t.me")) platform = "telegram";
        else if (hostname.includes("linkedin.com")) platform = "linkedin";
        else if (hostname.includes("snapchat.com")) platform = "snapchat";
        else if (hostname.includes("likee.video")) platform = "likee";
      } catch (e) {}

      await logDownload(job.userId, platform, job.title, job.thumbnail || null, job.url, job.format);
      await incrementPlatformUsage(job.userId, platform);

    } catch (err: any) {
      if (retriesLeft > 0) {
        logger.warn(`Job ${job.id} failed. Retrying... (${retriesLeft} retries left). Error: ${err.message}`);
        job.statusText = `Retrying... (${retriesLeft} attempts left)`;
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return await this.executeWithRetry(job, retriesLeft - 1);
      } else {
        job.status = "failed";
        job.progress = 0;
        job.statusText = "Failed";
        job.error = err.message || "Download failed";
        job.updatedAt = new Date();
        throw err;
      }
    }
  }

  private startCleanupWorker() {
    // Run cleanup every 10 minutes
    setInterval(() => {
      logger.info("Running files cleanup worker...");
      const tempDir = getTempDir();
      const cutoffTime = Date.now() - 60 * 60 * 1000; // 1 hour ago

      try {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
          const filePath = path.join(tempDir, file);
          const stat = fs.statSync(filePath);
          if (stat.birthtimeMs < cutoffTime) {
            fs.unlinkSync(filePath);
            logger.info(`Cleanup worker deleted expired file: ${file}`);
          }
        }
      } catch (err: any) {
        logger.error("Cleanup worker encountered error:", err);
      }
    }, 10 * 60 * 1000);
  }
}

export const jobQueue = new JobQueue();
