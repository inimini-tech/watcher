import fs from "node:fs";
import path from "path";
import os from "os";
import sharp from "sharp";
import { config } from "./config";
import { shortPath, log } from "./logging";
import { GoogleGenAI, JobState } from "@google/genai";
import {
  logBatchSubmitted,
  logBatchStatus,
  logBatchReceived,
  logBatchComplete,
  logBatchError,
} from "./batch-logger";

// --- Constants ---

const MAX_BATCH_SIZE = 10;
const DOWNLOAD_DELAY_MS = 15_000; // 15 seconds delay after job success
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 5_000; // 5 seconds, doubles each retry

// --- Types ---

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface BatchJobState {
  jobName: string;
  files: string[]; // original filenames
  fileDimensions: Record<string, ImageDimensions>; // original dimensions per file
  submittedAt: number;
  status: "pending" | "running" | "succeeded" | "failed";
}

// --- State ---

export const STATE_FILE = path.join(__dirname, "..", "agents-state.json");
let pendingJobs: BatchJobState[] = [];

function loadState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      pendingJobs = JSON.parse(raw);
      log(`Loaded ${pendingJobs.length} pending agent job(s) from state`, "NOTICE");
    }
  } catch (err: any) {
    log(`Failed to load agents state: ${err.message}`, "ERROR");
    pendingJobs = [];
  }
}

function saveState(): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(pendingJobs, null, 2), "utf-8");
  } catch (err: any) {
    log(`Failed to save agents state: ${err.message}`, "ERROR");
  }
}

// --- Gemini client ---

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set");
  }
  return new GoogleGenAI({ apiKey });
}

function getModel(): string {
  return process.env.GEMINI_BATCH_MODEL || "gemini-3-pro-image-preview";
}

// --- Helpers ---

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];

function isImageFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    log(`Created directory: ${shortPath(dirPath)}`, "NOTICE");
  }
}

function getImageFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath);
  return files.filter((f) => {
    if (f.startsWith(".")) return false;
    const filePath = path.join(dirPath, f);
    try {
      const stats = fs.statSync(filePath);
      return stats.isFile() && stats.size > 0 && isImageFile(f);
    } catch {
      return false;
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY_MS * 2 ** attempt;
        log(
          `[Agents] ${label} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message}. Retrying in ${delay / 1000}s...`,
          "WARNING",
        );
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// --- Task A: Submit new files ---

async function submitNewFiles(): Promise<void> {
  const files = getImageFiles(config.AGENTS_WATCH_PATH);
  if (files.length === 0) return;

  log(`[Agents] Found ${files.length} new image(s) to process`, "NOTICE");

  ensureDir(config.AGENTS_PROCESSING_PATH);

  // Move files to processing folder
  const movedFiles: string[] = [];
  for (const filename of files) {
    const src = path.join(config.AGENTS_WATCH_PATH, filename);
    const dest = path.join(config.AGENTS_PROCESSING_PATH, filename);
    try {
      fs.renameSync(src, dest);
      movedFiles.push(filename);
      log(`[Agents] Moved ${shortPath(src)} → processing`, "NOTICE");
    } catch (err: any) {
      log(`[Agents] Failed to move ${filename}: ${err.message}`, "ERROR");
    }
  }

  if (movedFiles.length === 0) return;

  // Split into smaller batches
  const batches = chunkArray(movedFiles, MAX_BATCH_SIZE);
  log(
    `[Agents] Splitting ${movedFiles.length} image(s) into ${batches.length} batch(es) of up to ${MAX_BATCH_SIZE}`,
    "NOTICE",
  );

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batchFiles = batches[batchIndex];
    try {
      await submitBatch(batchFiles, batchIndex + 1, batches.length);
    } catch (err: any) {
      log(
        `[Agents] Failed to submit batch ${batchIndex + 1}/${batches.length}: ${err.message}`,
        "ERROR",
      );

      // Move files back to watch folder on failure
      for (const filename of batchFiles) {
        const src = path.join(config.AGENTS_PROCESSING_PATH, filename);
        const dest = path.join(config.AGENTS_WATCH_PATH, filename);
        try {
          if (fs.existsSync(src)) {
            fs.renameSync(src, dest);
            log(`[Agents] Moved ${filename} back to watch folder`, "WARNING");
          }
        } catch (moveErr: any) {
          log(`[Agents] Failed to move ${filename} back: ${moveErr.message}`, "ERROR");
        }
      }
    }
  }
}

async function submitBatch(
  batchFiles: string[],
  batchNum: number,
  totalBatches: number,
): Promise<void> {
  const client = getClient();
  const model = getModel();

  // Read original dimensions and build JSONL content
  const fileDimensions: Record<string, ImageDimensions> = {};
  const jsonlLines: string[] = [];
  for (const filename of batchFiles) {
    const filePath = path.join(config.AGENTS_PROCESSING_PATH, filename);
    const fileData = fs.readFileSync(filePath);
    const base64 = fileData.toString("base64");
    const mimeType = getMimeType(filename);

    // Store original dimensions
    try {
      const metadata = await sharp(fileData).metadata();
      if (metadata.width && metadata.height) {
        fileDimensions[filename] = { width: metadata.width, height: metadata.height };
        log(`[Agents] ${filename} original size: ${metadata.width}x${metadata.height}`, "NOTICE");
      }
    } catch (dimErr: any) {
      log(`[Agents] Could not read dimensions for ${filename}: ${dimErr.message}`, "WARNING");
    }

    const request = {
      key: filename,
      request: {
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64,
                },
              },
              {
                text: "Remove some wrinkles. Don't change the layout.",
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: {
            aspectRatio: "1:1",
            imageSize: "1K",
          },
        },
      },
    };
    jsonlLines.push(JSON.stringify(request));
  }

  const jsonlContent = jsonlLines.join("\n");
  const timestamp = Date.now();

  log(
    `[Agents] Uploading batch ${batchNum}/${totalBatches} JSONL (${batchFiles.length} images)...`,
    "NOTICE",
  );

  // Upload JSONL to Gemini File API using Blob to avoid Node.js
  // FileHandle.read() compatibility issues with the SDK
  const jsonlBlob = new Blob([jsonlContent], {
    type: "application/vnd.google.generativeai.jsonl",
  });
  const uploadedFile = await client.files.upload({
    file: jsonlBlob,
    config: {
      mimeType: "application/vnd.google.generativeai.jsonl",
      displayName: `agents-batch-${timestamp}-${batchNum}`,
    },
  });

  if (!uploadedFile.name) {
    throw new Error("Upload succeeded but no file name returned");
  }

  log(`[Agents] Uploaded file: ${uploadedFile.name}`, "NOTICE");

  // Create batch job
  const batchJob = await client.batches.create({
    model: model,
    src: uploadedFile.name,
    config: {
      displayName: `agents-upscale-${timestamp}-${batchNum}`,
    },
  });

  if (!batchJob.name) {
    throw new Error("Batch job created but no name returned");
  }

  log(
    `[Agents] Created batch job ${batchNum}/${totalBatches}: ${batchJob.name}`,
    "NOTICE",
  );

  logBatchSubmitted(batchJob.name, batchFiles);

  // Track job
  const jobState: BatchJobState = {
    jobName: batchJob.name,
    files: batchFiles,
    fileDimensions,
    submittedAt: timestamp,
    status: "pending",
  };
  pendingJobs.push(jobState);
  saveState();
}

// --- Task B: Check pending jobs ---

async function checkPendingJobs(): Promise<void> {
  if (pendingJobs.length === 0) return;

  const client = getClient();

  // Check all jobs concurrently
  const results = await Promise.allSettled(
    pendingJobs.map((job, i) => checkSingleJob(client, job, i)),
  );

  // Collect indices to remove (jobs that are done)
  const jobsToRemove: number[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value !== undefined) {
      jobsToRemove.push(result.value);
    }
  }

  // Remove completed/failed jobs from list (reverse to keep indices valid)
  if (jobsToRemove.length > 0) {
    jobsToRemove.sort((a, b) => b - a);
    for (const idx of jobsToRemove) {
      pendingJobs.splice(idx, 1);
    }
    saveState();
  }
}

async function checkSingleJob(
  client: GoogleGenAI,
  job: BatchJobState,
  index: number,
): Promise<number | undefined> {
  if (job.status === "succeeded" || job.status === "failed") {
    return index;
  }

  try {
    const result = await client.batches.get({ name: job.jobName });
    log(`[Agents] Job ${job.jobName} status: ${result.state}`, "NOTICE");

    if (result.state === JobState.JOB_STATE_SUCCEEDED) {
      job.status = "succeeded";
      log(`[Agents] Batch job succeeded: ${job.jobName}`, "NOTICE");
      logBatchStatus(job.jobName, "succeeded");

      // Wait before downloading to let the file API catch up
      log(
        `[Agents] Waiting ${DOWNLOAD_DELAY_MS / 1000}s before downloading results...`,
        "NOTICE",
      );
      await sleep(DOWNLOAD_DELAY_MS);

      // Download and process results with retry
      try {
        await processJobResults(client, job, result);
      } catch (processErr: any) {
        log(`[Agents] Failed to process results, moving files back: ${processErr.message}`, "ERROR");
        logBatchError(job.jobName, `Failed to process results: ${processErr.message}`);
        moveFilesBack(job.files);
      }
      return index;
    } else if (result.state === JobState.JOB_STATE_FAILED) {
      job.status = "failed";
      log(`[Agents] Batch job failed: ${job.jobName}`, "ERROR");
      logBatchError(job.jobName, "Batch job failed");

      // Move originals back to watch folder
      moveFilesBack(job.files);
      return index;
    } else if (result.state === JobState.JOB_STATE_CANCELLED) {
      job.status = "failed";
      log(`[Agents] Batch job cancelled: ${job.jobName}`, "WARNING");
      logBatchError(job.jobName, "Batch job cancelled");

      moveFilesBack(job.files);
      return index;
    }
    // Otherwise still pending/running — leave it
    return undefined;
  } catch (err: any) {
    log(`[Agents] Failed to check job ${job.jobName}: ${err.message}`, "ERROR");
    return undefined;
  }
}

async function processJobResults(
  client: GoogleGenAI,
  job: BatchJobState,
  result: any,
): Promise<void> {
  ensureDir(config.AGENTS_UPSCALE_OUT_PATH);

  try {
    const destFileName = result.dest?.fileName;
    if (!destFileName) {
      log(`[Agents] No output file found for job ${job.jobName}`, "WARNING");
      logBatchError(job.jobName, "No output file returned by Gemini");
      moveFilesBack(job.files);
      return;
    }

    // Download result JSONL with retry
    const tempDir = os.tmpdir();
    const tempOutputPath = path.join(tempDir, `agents-result-${Date.now()}.jsonl`);

    await retryWithBackoff(
      () =>
        client.files.download({
          file: destFileName,
          downloadPath: tempOutputPath,
        }),
      `Download results for ${job.jobName}`,
    );

    log(`[Agents] Downloaded results for job ${job.jobName}`, "NOTICE");

    // Parse result JSONL
    const content = fs.readFileSync(tempOutputPath, "utf-8");
    const lines = content.trim().split("\n");

    let savedCount = 0;
    const filesWithResults = new Set<string>();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const key = parsed.key || `unknown-${Date.now()}`;
        const response = parsed.response;

        if (response?.candidates) {
          for (const candidate of response.candidates) {
            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.inlineData?.data) {
                  // Save the image
                  const ext = part.inlineData.mimeType === "image/png" ? ".png" : ".jpg";
                  const baseName = path.parse(key).name;
                  const outputFilename = `${baseName}${ext}`;
                  const outputPath = path.join(config.AGENTS_UPSCALE_OUT_PATH, outputFilename);

                  let imageBuffer = Buffer.from(part.inlineData.data, "base64");

                  // Resize to original dimensions if known
                  const originalDims = job.fileDimensions?.[key];
                  if (originalDims) {
                    imageBuffer = await sharp(imageBuffer)
                      .resize(originalDims.width, originalDims.height)
                      .toBuffer();
                    log(
                      `[Agents] Resized ${outputFilename} to ${originalDims.width}x${originalDims.height}`,
                      "NOTICE",
                    );
                  }

                  fs.writeFileSync(outputPath, imageBuffer);
                  savedCount++;
                  filesWithResults.add(key);

                  logBatchReceived(job.jobName, outputFilename);
                  log(`[Agents] Saved image: ${shortPath(outputPath)}`, "NOTICE");
                } else if (part.text) {
                  log(
                    `[Agents] Response text for ${key}: ${part.text.substring(0, 200)}`,
                    "NOTICE",
                  );
                }
              }
            }
          }
        } else {
          log(`[Agents] No image returned for ${key}`, "WARNING");
          logBatchError(job.jobName, `No image returned for: ${key}`);
        }
      } catch (parseErr: any) {
        log(`[Agents] Failed to parse result line: ${parseErr.message}`, "ERROR");
        logBatchError(job.jobName, `Failed to parse result line: ${parseErr.message}`);
      }
    }

    log(`[Agents] Saved ${savedCount} image(s)`, "NOTICE");
    logBatchComplete(job.jobName, job.files.length, savedCount);

    // Move back files that Gemini didn't return so they can be retried
    const missingFiles = job.files.filter((f) => !filesWithResults.has(f));
    if (missingFiles.length > 0) {
      log(
        `[Agents] ${missingFiles.length} file(s) got no result, moving back for retry: ${missingFiles.join(", ")}`,
        "WARNING",
      );
      logBatchError(job.jobName, `Files without results: ${missingFiles.join(", ")}`);
      moveFilesBack(missingFiles);
    }

    // Clean up temp file
    try {
      fs.unlinkSync(tempOutputPath);
    } catch {
      // ignore
    }

    // Clean up processing files (only those that got results)
    for (const filename of Array.from(filesWithResults)) {
      const processingPath = path.join(config.AGENTS_PROCESSING_PATH, filename);
      try {
        if (fs.existsSync(processingPath)) {
          fs.unlinkSync(processingPath);
        }
      } catch {
        // ignore
      }
    }
  } catch (err: any) {
    log(
      `[Agents] Failed to process results for job ${job.jobName}: ${err.message}`,
      "ERROR",
    );
    logBatchError(job.jobName, `Failed to process results: ${err.message}`);
    throw err;
  }
}

function moveFilesBack(files: string[]): void {
  for (const filename of files) {
    const src = path.join(config.AGENTS_PROCESSING_PATH, filename);
    const dest = path.join(config.AGENTS_WATCH_PATH, filename);
    try {
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
        log(`[Agents] Moved ${filename} back to watch folder`, "WARNING");
      }
    } catch (err: any) {
      log(`[Agents] Failed to move ${filename} back: ${err.message}`, "ERROR");
    }
  }
}

// --- Main entry point ---

const INTERVAL_MS = 300000; // 5 minutes

export function startAgentsWatcher(): void {
  log("[Agents] Starting agents hotfolder watcher", "NOTICE");

  // Ensure directories exist
  ensureDir(config.AGENTS_WATCH_PATH);
  ensureDir(config.AGENTS_UPSCALE_OUT_PATH);
  ensureDir(config.AGENTS_PROCESSING_PATH);

  // Load persisted state
  loadState();

  // Run immediately on start
  runAgentsCycle();

  // Then run every 5 minutes
  setInterval(() => {
    runAgentsCycle();
  }, INTERVAL_MS);

  log(
    `[Agents] Watching ${shortPath(config.AGENTS_WATCH_PATH)} (interval: ${INTERVAL_MS / 1000}s)`,
    "NOTICE",
  );
}

async function runAgentsCycle(): Promise<void> {
  try {
    await checkPendingJobs();
  } catch (err: any) {
    log(`[Agents] Error checking pending jobs: ${err.message}`, "ERROR");
  }

  try {
    await submitNewFiles();
  } catch (err: any) {
    log(`[Agents] Error submitting new files: ${err.message}`, "ERROR");
  }
}
