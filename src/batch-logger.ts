import fs from "node:fs";
import path from "path";
import { config } from "./config";

const LOGS_DIR = path.join(config.AGENTS_PROCESSING_PATH, "..", "_AGENTS_LOGS");

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function getLogPath(jobName: string): string {
  ensureLogsDir();
  const safe = jobName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(LOGS_DIR, `${safe}.log`);
}

function append(jobName: string, message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(getLogPath(jobName), line, "utf-8");
}

export function logBatchSubmitted(
  jobName: string,
  files: string[],
): void {
  append(jobName, `BATCH SUBMITTED`);
  append(jobName, `Files sent: ${files.length}`);
  files.forEach((f) => append(jobName, `  → ${f}`));
}

export function logBatchStatus(
  jobName: string,
  status: string,
): void {
  append(jobName, `STATUS: ${status}`);
}

export function logBatchReceived(
  jobName: string,
  filename: string,
): void {
  append(jobName, `RECEIVED: ${filename}`);
}

export function logBatchComplete(
  jobName: string,
  sentCount: number,
  receivedCount: number,
): void {
  append(jobName, `BATCH COMPLETE — sent: ${sentCount}, received: ${receivedCount}`);
  if (receivedCount < sentCount) {
    append(jobName, `WARNING: ${sentCount - receivedCount} file(s) missing from results`);
  }
}

export function logBatchError(
  jobName: string,
  message: string,
): void {
  append(jobName, `ERROR: ${message}`);
}
