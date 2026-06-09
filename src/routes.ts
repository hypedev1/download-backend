import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as fs from "node:fs";
import { config } from "./config.js";
import { extractMetadata } from "./yt-dlp.js";
import { jobQueue } from "./queue.js";
import { logger } from "./logger.js";

// Hook to verify API key
async function verifyApiKey(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers["x-api-key"];
  if (!apiKey || apiKey !== config.BACKEND_API_KEY) {
    reply.code(401).send({ error: "Unauthorized. Invalid API Key." });
  }
}

export async function registerRoutes(fastify: FastifyInstance) {
  // POST /extract
  fastify.post(
    "/extract",
    { preHandler: [verifyApiKey] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { url?: string };
      if (!body.url) {
        return reply.code(400).send({ error: "Missing url parameter" });
      }

      try {
        const metadata = await extractMetadata(body.url);
        return reply.send(metadata);
      } catch (err: any) {
        return reply.code(500).send({ error: err.message || "Failed to extract metadata" });
      }
    }
  );

  // POST /download
  fastify.post(
    "/download",
    { preHandler: [verifyApiKey] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        url?: string;
        format?: "mp4" | "mp3" | "thumbnail";
        quality?: string;
        title?: string;
        thumbnail?: string;
        userId?: string;
      };

      if (!body.url || !body.format || !body.userId) {
        return reply.code(400).send({ error: "Missing required parameters: url, format, userId" });
      }

      try {
        const job = jobQueue.createJob({
          url: body.url,
          format: body.format,
          quality: body.quality,
          title: body.title || "Untitled Media",
          thumbnail: body.thumbnail,
          userId: body.userId,
        });

        return reply.send({ jobId: job.id, status: job.status });
      } catch (err: any) {
        return reply.code(500).send({ error: err.message || "Failed to initiate download job" });
      }
    }
  );

  // GET /status/:jobId
  fastify.get(
    "/status/:jobId",
    { preHandler: [verifyApiKey] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { jobId: string };
      const job = jobQueue.getJob(params.jobId);

      if (!job) {
        return reply.code(404).send({ error: "Job not found" });
      }

      // If the download link is local, construct the full URL pointing to the VPS backend
      let downloadUrl = job.downloadUrl;
      if (downloadUrl && downloadUrl.startsWith("/file/")) {
        // Construct the VPS endpoint URL
        const protocol = request.headers["x-forwarded-proto"] || "http";
        const host = request.headers["host"] || `${config.HOST}:${config.PORT}`;
        downloadUrl = `${protocol}://${host}${downloadUrl}`;
      }

      return reply.send({
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        statusText: job.statusText,
        error: job.error,
        downloadUrl,
      });
    }
  );

  // GET /file/:jobId
  // This endpoint serves the file and deletes it after streaming is completed.
  // We do NOT require API key here as it is visited by the client browser directly.
  fastify.get(
    "/file/:fileBasename",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { fileBasename: string };
      
      // Sanitize input to prevent path traversal
      const basename = path.basename(params.fileBasename);
      const filePath = path.resolve("./downloads-temp", basename);

      if (!fs.existsSync(filePath)) {
        return reply.code(404).send("File not found on VPS server");
      }

      const stream = fs.createReadStream(filePath);
      const contentType = basename.endsWith(".mp3")
        ? "audio/mpeg"
        : basename.endsWith(".jpg") || basename.endsWith(".jpeg")
        ? "image/jpeg"
        : "video/mp4";

      reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(basename)}"`);
      reply.header("Content-Type", contentType);

      // Delete file after connection closes / stream finishes
      stream.on("close", () => {
        try {
          fs.unlinkSync(filePath);
          logger.info(`Stream completed. Deleted local file: ${filePath}`);
        } catch (err: any) {
          logger.error(`Failed to delete local file after stream: ${filePath}`, err);
        }
      });

      return reply.send(stream);
    }
  );
}

import * as path from "node:path";
