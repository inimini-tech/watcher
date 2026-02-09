import fs from "node:fs";
import path from "path";
import os from "os";
import { config } from "./config";
import { shortPath, log } from "./logging";
import { GoogleGenAI, JobState } from "@google/genai";

// --- Types ---

interface BatchJobState {
  jobName: string;
  files: string[]; // original filenames
  submittedAt: number;
  status: "pending" | "running" | "succeeded" | "failed";
}

// --- State ---

const STATE_FILE = path.join(__dirname, "agents-state.json");
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

  try {
    const client = getClient();
    const model = getModel();

    // Build JSONL content
    const jsonlLines: string[] = [];
    for (const filename of movedFiles) {
      const filePath = path.join(config.AGENTS_PROCESSING_PATH, filename);
      const fileData = fs.readFileSync(filePath);
      const base64 = fileData.toString("base64");
      const mimeType = getMimeType(filename);

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
        },
      };
      jsonlLines.push(JSON.stringify(request));
    }

    const jsonlContent = jsonlLines.join("\n");
    const timestamp = Date.now();

    log(`[Agents] Uploading batch JSONL (${movedFiles.length} images)...`, "NOTICE");

    // Upload JSONL to Gemini File API using Blob to avoid Node.js
    // FileHandle.read() compatibility issues with the SDK
    const jsonlBlob = new Blob([jsonlContent], {
      type: "application/vnd.google.generativeai.jsonl",
    });
    const uploadedFile = await client.files.upload({
      file: jsonlBlob,
      config: {
        mimeType: "application/vnd.google.generativeai.jsonl",
        displayName: `agents-batch-${timestamp}`,
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
        displayName: `agents-upscale-${timestamp}`,
      },
    });

    if (!batchJob.name) {
      throw new Error("Batch job created but no name returned");
    }

    log(`[Agents] Created batch job: ${batchJob.name}`, "NOTICE");

    // Track job
    const jobState: BatchJobState = {
      jobName: batchJob.name,
      files: movedFiles,
      submittedAt: timestamp,
      status: "pending",
    };
    pendingJobs.push(jobState);
    saveState();
  } catch (err: any) {
    log(`[Agents] Failed to submit batch job: ${err.message}`, "ERROR");

    // Move files back to watch folder on failure
    for (const filename of movedFiles) {
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

// --- Task B: Check pending jobs ---

async function checkPendingJobs(): Promise<void> {
  if (pendingJobs.length === 0) return;

  const client = getClient();
  const jobsToRemove: number[] = [];

  for (let i = 0; i < pendingJobs.length; i++) {
    const job = pendingJobs[i];
    if (job.status === "succeeded" || job.status === "failed") {
      jobsToRemove.push(i);
      continue;
    }

    try {
      const result = await client.batches.get({ name: job.jobName });
      log(`[Agents] Job ${job.jobName} status: ${result.state}`, "NOTICE");

      if (result.state === JobState.JOB_STATE_SUCCEEDED) {
        job.status = "succeeded";
        log(`[Agents] Batch job succeeded: ${job.jobName}`, "NOTICE");

        // Download and process results
        await processJobResults(client, job, result);
        jobsToRemove.push(i);
      } else if (result.state === JobState.JOB_STATE_FAILED) {
        job.status = "failed";
        log(`[Agents] Batch job failed: ${job.jobName}`, "ERROR");

        // Move originals back to watch folder
        moveFilesBack(job.files);
        jobsToRemove.push(i);
      } else if (result.state === JobState.JOB_STATE_CANCELLED) {
        job.status = "failed";
        log(`[Agents] Batch job cancelled: ${job.jobName}`, "WARNING");

        moveFilesBack(job.files);
        jobsToRemove.push(i);
      }
      // Otherwise still pending/running — leave it
    } catch (err: any) {
      log(`[Agents] Failed to check job ${job.jobName}: ${err.message}`, "ERROR");
    }
  }

  // Remove completed/failed jobs from list (reverse to keep indices valid)
  if (jobsToRemove.length > 0) {
    for (let i = jobsToRemove.length - 1; i >= 0; i--) {
      pendingJobs.splice(jobsToRemove[i], 1);
    }
    saveState();
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
      return;
    }

    // Download result JSONL
    const tempDir = os.tmpdir();
    const tempOutputPath = path.join(tempDir, `agents-result-${Date.now()}.jsonl`);

    await client.files.download({
      file: destFileName,
      downloadPath: tempOutputPath,
    });

    log(`[Agents] Downloaded results for job ${job.jobName}`, "NOTICE");

    // Parse result JSONL
    const content = fs.readFileSync(tempOutputPath, "utf-8");
    const lines = content.trim().split("\n");

    let savedCount = 0;
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
                  const outputFilename = `${baseName}_upscaled${ext}`;
                  const outputPath = path.join(config.AGENTS_UPSCALE_OUT_PATH, outputFilename);

                  const imageBuffer = Buffer.from(part.inlineData.data, "base64");
                  fs.writeFileSync(outputPath, imageBuffer);
                  savedCount++;

                  log(`[Agents] Saved upscaled image: ${shortPath(outputPath)}`, "NOTICE");
                } else if (part.text) {
                  log(
                    `[Agents] Response text for ${key}: ${part.text.substring(0, 200)}`,
                    "NOTICE",
                  );
                }
              }
            }
          }
        }
      } catch (parseErr: any) {
        log(`[Agents] Failed to parse result line: ${parseErr.message}`, "ERROR");
      }
    }

    log(`[Agents] Saved ${savedCount} upscaled image(s)`, "NOTICE");

    // Clean up temp file
    try {
      fs.unlinkSync(tempOutputPath);
    } catch {
      // ignore
    }

    // Clean up processing files
    for (const filename of job.files) {
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
    log(`[Agents] Failed to process results for job ${job.jobName}: ${err.message}`, "ERROR");
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
