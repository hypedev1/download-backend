import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { registerRoutes } from "./routes.js";
import { logger } from "./logger.js";
import { ensureBinaries } from "./yt-dlp.js";

const fastify = Fastify({
  logger: false, // We use our custom formatted logger
});

async function start() {
  try {
    // Self-healing binary checks
    logger.info("Verifying system binaries...");
    await ensureBinaries();

    // Enable CORS
    await fastify.register(cors, {
      origin: "*",
      methods: ["GET", "POST"],
    });

    // Register API routes
    await fastify.register(registerRoutes);

    logger.info(`Starting Fastify server...`);
    await fastify.listen({ port: config.PORT, host: config.HOST });
    logger.info(`VPS Backend running on http://${config.HOST}:${config.PORT}`);
  } catch (err: any) {
    logger.error("Error starting backend server:", err);
    process.exit(1);
  }
}

start();

