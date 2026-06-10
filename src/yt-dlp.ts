import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface ExtractedFormat {
  formatId: string;
  ext: string;
  resolution: string;
  quality: string;
  height: number | null;
}

export interface ExtractedMetadata {
  title: string;
  thumbnail: string | null;
  duration: number;
  author: string | null;
  views: number | null;
  formats: ExtractedFormat[];
}

// Locate binaries
function getBinPaths() {
  const isWin = process.platform === "win32";
  const localBinDir = isWin ? path.resolve(process.cwd(), "./bin") : "/tmp/bin";
  const devBinDir = path.resolve(process.cwd(), "../bin");
  
  let binDir = "";
  if (fs.existsSync(devBinDir)) {
    binDir = devBinDir;
  } else if (fs.existsSync(localBinDir)) {
    binDir = localBinDir;
  } else {
    binDir = localBinDir;
  }

  const ytDlp = binDir && fs.existsSync(path.join(binDir, isWin ? "yt-dlp.exe" : "yt-dlp"))
    ? path.join(binDir, isWin ? "yt-dlp.exe" : "yt-dlp")
    : "yt-dlp";

  const ffmpeg = binDir && fs.existsSync(path.join(binDir, isWin ? "ffmpeg.exe" : "ffmpeg"))
    ? path.join(binDir, isWin ? "ffmpeg.exe" : "ffmpeg")
    : "ffmpeg";

  return { binDir, ytDlp, ffmpeg };
}

let envCookiesWritten = false;

// Find cookies path
function getCookiesPath(): string | null {
  // Check if env variable is set
  if (process.env.YT_DLP_COOKIES_CONTENT) {
    const tempDir = fs.existsSync("/tmp") ? "/tmp" : path.resolve("./downloads-temp");
    const envCookiesPath = path.join(tempDir, "cookies_env.txt");
    try {
      if (!envCookiesWritten) {
        fs.writeFileSync(envCookiesPath, process.env.YT_DLP_COOKIES_CONTENT, "utf8");
        envCookiesWritten = true;
        logger.info(`Successfully wrote YT_DLP_COOKIES_CONTENT to ${envCookiesPath}`);
      }
      return envCookiesPath;
    } catch (err) {
      logger.error("Failed to write YT_DLP_COOKIES_CONTENT to file:", err);
    }
  }

  // Check parent root cookies
  const parentCookies = path.resolve(process.cwd(), "../cookies.txt");
  if (fs.existsSync(parentCookies)) {
    return parentCookies;
  }

  // Check current directory cookies
  const localCookies = path.resolve(process.cwd(), "cookies.txt");
  if (fs.existsSync(localCookies)) {
    return localCookies;
  }

  return null;
}

export async function extractMetadata(url: string): Promise<ExtractedMetadata> {
  const { ytDlp } = getBinPaths();
  const cookiesFile = getCookiesPath();
  
  const args = ["--dump-json", "--no-playlist", "--no-cache-dir", url];
  if (cookiesFile) {
    args.unshift("--cookies", cookiesFile);
  }

  logger.info(`Extracting metadata using: ${ytDlp} ${args.join(" ")}`);

  try {
    const { stdout } = await execFileAsync(ytDlp, args, { maxBuffer: 10 * 1024 * 1024 });
    const data = JSON.parse(stdout);

    const title = data.title || data.fulltitle || "Unknown Title";
    const thumbnail = data.thumbnail || (data.thumbnails && data.thumbnails.length > 0 ? data.thumbnails[data.thumbnails.length - 1].url : null);
    const duration = data.duration || 0;
    const author = data.uploader || data.channel || data.creator || "Unknown Creator";
    const views = data.view_count || null;

    const formatsList: ExtractedFormat[] = [];
    const heightsSeen = new Set<number>();

    const rawFormats = data.formats || [];
    for (const f of rawFormats) {
      if (f.vcodec !== "none" && f.height) {
        heightsSeen.add(f.height);
      }
    }

    const sortedHeights = Array.from(heightsSeen).sort((a, b) => b - a);

    for (const height of sortedHeights) {
      const quality = `${height}p`;
      const matching = rawFormats.filter((f: any) => f.height === height && f.vcodec !== "none");
      const bestMatch = matching.find((f: any) => f.acodec !== "none") || matching[0];

      formatsList.push({
        formatId: `bestvideo[height<=${height}]+bestaudio/best`,
        ext: "mp4",
        resolution: bestMatch ? `${bestMatch.width}x${bestMatch.height}` : "Auto",
        quality,
        height,
      });
    }

    // Fallback if no heights extracted
    if (formatsList.length === 0) {
      formatsList.push({
        formatId: "best",
        ext: "mp4",
        resolution: "Auto",
        quality: "Auto/Best Quality",
        height: null,
      });
    }

    return {
      title,
      thumbnail,
      duration,
      author,
      views,
      formats: formatsList,
    };
  } catch (err: any) {
    logger.error(`Failed to extract metadata for URL ${url}:`, err);
    throw new Error(err.stderr || err.message || "Failed to extract video metadata");
  }
}

export function downloadMediaStream(
  url: string,
  format: "mp4" | "mp3" | "thumbnail",
  quality: string | undefined,
  outPath: string,
  onProgress: (progress: number, statusText: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { ytDlp, binDir } = getBinPaths();
    const cookiesFile = getCookiesPath();
    const args: string[] = ["--no-playlist", "--no-cache-dir"];

    if (cookiesFile) {
      args.push("--cookies", cookiesFile);
    }

    if (binDir) {
      args.push("--ffmpeg-location", binDir);
    }

    if (format === "thumbnail") {
      // Thumbnail download
      args.push("--write-thumbnail", "--skip-download", "-o", `${outPath.replace(/\.[^/.]+$/, "")}`);
      args.push(url);
    } else if (format === "mp3") {
      // Audio download
      args.push("-f", "bestaudio/best");
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
      args.push("-o", outPath);
      args.push(url);
    } else {
      // Video download
      let formatSelector = "bestvideo+bestaudio/best";
      if (quality) {
        const heightMatch = quality.match(/(\d+)p/);
        if (heightMatch) {
          const height = heightMatch[1];
          formatSelector = `bestvideo[height<=${height}]+bestaudio/best/best[height<=${height}]/best`;
        }
      }
      args.push("-f", formatSelector);
      args.push("--merge-output-format", "mp4");
      args.push("-o", outPath);
      args.push(url);
    }

    logger.info(`Spawning yt-dlp: ${ytDlp} ${args.join(" ")}`);
    const child = spawn(ytDlp, args);

    let stderrOutput = "";

    child.stdout.on("data", (data) => {
      const line = data.toString();
      
      // Parse progress: [download]  12.2% of  16.42MiB at  1.21MiB/s ETA 00:11
      const progressMatch = line.match(/\[download\]\s+(\d+\.\d+)%/);
      if (progressMatch) {
        const percent = parseFloat(progressMatch[1]);
        onProgress(percent, `Downloading (${percent.toFixed(1)}%)`);
      }

      // Parse status changes
      if (line.includes("[Merger]")) {
        onProgress(95, "Merging audio and video...");
      } else if (line.includes("[ExtractAudio]")) {
        onProgress(95, "Extracting audio track...");
      }
    });

    child.stderr.on("data", (data) => {
      stderrOutput += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        // For thumbnail download, yt-dlp saves with original extension, e.g. outPath.webp or outPath.jpg.
        // We should ensure the file is at the exact outPath.
        if (format === "thumbnail") {
          const baseNoExt = outPath.replace(/\.[^/.]+$/, "");
          const extensions = [".jpg", ".jpeg", ".webp", ".png"];
          let foundFile = "";
          for (const ext of extensions) {
            const possibleFile = baseNoExt + ext;
            if (fs.existsSync(possibleFile)) {
              foundFile = possibleFile;
              break;
            }
          }
          if (foundFile) {
            if (foundFile !== outPath) {
              fs.renameSync(foundFile, outPath);
            }
          } else {
            reject(new Error("Thumbnail download succeeded but the thumbnail file was not found."));
            return;
          }
        }

        resolve();
      } else {
        logger.error(`yt-dlp process exited with code ${code}. Stderr: ${stderrOutput}`);
        reject(new Error(`Download failed with exit code ${code}: ${stderrOutput.trim()}`));
      }
    });

    child.on("error", (err) => {
      logger.error("Failed to start yt-dlp spawn process:", err);
      reject(err);
    });
  });
}

// Try to require ffmpeg-static dynamically in ESM
async function getFfmpegStaticPath(): Promise<string | null> {
  try {
    const ffmpegStatic = (await import("ffmpeg-static")) as any;
    return ffmpegStatic.default || ffmpegStatic || null;
  } catch (e) {
    return null;
  }
}

export async function ensureBinaries(): Promise<void> {
  const isWin = process.platform === "win32";
  const localBinDir = isWin ? path.resolve("./bin") : "/tmp/bin";
  
  if (!fs.existsSync(localBinDir)) {
    fs.mkdirSync(localBinDir, { recursive: true });
  }

  const ytDlpFilename = isWin ? "yt-dlp.exe" : "yt-dlp";
  const ffmpegFilename = isWin ? "ffmpeg.exe" : "ffmpeg";

  const localYtDlp = path.join(localBinDir, ytDlpFilename);
  const localFfmpeg = path.join(localBinDir, ffmpegFilename);

  // Check if globally available
  const hasGlobalYtDlp = await checkCommand("yt-dlp --version");
  const hasGlobalFfmpeg = await checkCommand("ffmpeg -version");

  if (!hasGlobalFfmpeg && !fs.existsSync(localFfmpeg)) {
    logger.info("ffmpeg not found globally. Copying from ffmpeg-static...");
    const staticPath = await getFfmpegStaticPath();
    if (staticPath && fs.existsSync(staticPath)) {
      try {
        fs.copyFileSync(staticPath, localFfmpeg);
        if (!isWin) {
          fs.chmodSync(localFfmpeg, "755");
        }
        logger.info("ffmpeg binary copied successfully.");
      } catch (err: any) {
        logger.error(`Failed to copy ffmpeg binary: ${err.message}`);
      }
    } else {
      logger.warn("ffmpeg-static not found. FFmpeg operations may fail.");
    }
  }

  if (!hasGlobalYtDlp && !fs.existsSync(localYtDlp)) {
    logger.info("yt-dlp not found globally. Downloading standalone binary...");
    let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
    if (process.platform === "darwin") {
      url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
    } else if (isWin) {
      url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    }

    try {
      await downloadFile(url, localYtDlp);
      if (!isWin) {
        fs.chmodSync(localYtDlp, "755");
      }
      logger.info("yt-dlp downloaded and set up successfully.");
    } catch (err: any) {
      logger.error(`Failed to download yt-dlp: ${err.message}`);
    }
  }
}

function checkCommand(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(cmd, (error) => {
      resolve(!error);
    });
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    function get(downloadUrl: string) {
      try {
        const parsedUrl = new URL(downloadUrl);
        const options = {
          protocol: parsedUrl.protocol,
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        };

        https.get(options, (response) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            get(response.headers.location!);
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download file (Status Code ${response.statusCode})`));
            return;
          }

          const file = fs.createWriteStream(dest);
          response.pipe(file);

          file.on("finish", () => {
            file.close();
            resolve();
          });

          file.on("error", (err) => {
            fs.unlink(dest, () => {});
            reject(err);
          });
        }).on("error", (err) => {
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    }
    get(url);
  });
}

