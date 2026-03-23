import "dotenv/config";
import fs from "node:fs";
import path from "path";
import chalk from "chalk";
import type { BatchJobState } from "./agents";
import { config } from "./config";

const STATE_FILE = path.join(__dirname, "..", "agents-state.json");
const LOGS_DIR = path.join(config.AGENTS_PROCESSING_PATH, "..", "_AGENTS_LOGS");
const REFRESH_INTERVAL = 10000;

function loadState(): BatchJobState[] {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    // ignore
  }
  return [];
}

function statusColor(status: BatchJobState["status"]): string {
  switch (status) {
    case "pending":
      return chalk.yellow(status);
    case "running":
      return chalk.cyan(status);
    case "succeeded":
      return chalk.green(status);
    case "failed":
      return chalk.red(status);
    default:
      return status;
  }
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function render() {
  console.clear();
  const jobs = loadState();
  const now = new Date().toLocaleTimeString();

  console.log(chalk.bold(`\n  Agents Monitor`) + chalk.gray(`  ${now}  (refreshing every 10s)\n`));

  if (jobs.length === 0) {
    console.log(chalk.gray("  No jobs in state file.\n"));
    console.log(chalk.gray(`  State file: ${STATE_FILE}`));
    return;
  }

  // Header
  const header = `  ${"STATUS".padEnd(12)} ${"JOB".padEnd(52)} ${"FILES".padEnd(6)} ${"SUBMITTED"}`;
  console.log(chalk.gray(header));
  console.log(chalk.gray("  " + "─".repeat(90)));

  for (const job of jobs) {
    const status = statusColor(job.status).padEnd(12 + 10); // extra for ANSI codes
    const name = job.jobName.length > 50 ? "…" + job.jobName.slice(-49) : job.jobName;
    const files = String(job.files.length).padEnd(6);
    const submitted = timeAgo(job.submittedAt);

    console.log(`  ${status} ${name.padEnd(52)} ${files} ${submitted}`);

    if (job.files.length <= 5) {
      for (const f of job.files) {
        console.log(chalk.gray(`             ${f}`));
      }
    } else {
      for (const f of job.files.slice(0, 3)) {
        console.log(chalk.gray(`             ${f}`));
      }
      console.log(chalk.gray(`             ... and ${job.files.length - 3} more`));
    }
  }

  console.log();

  // Summary
  const pending = jobs.filter((j) => j.status === "pending").length;
  const running = jobs.filter((j) => j.status === "running").length;
  const succeeded = jobs.filter((j) => j.status === "succeeded").length;
  const failed = jobs.filter((j) => j.status === "failed").length;

  const parts: string[] = [];
  if (pending) parts.push(chalk.yellow(`${pending} pending`));
  if (running) parts.push(chalk.cyan(`${running} running`));
  if (succeeded) parts.push(chalk.green(`${succeeded} succeeded`));
  if (failed) parts.push(chalk.red(`${failed} failed`));

  console.log(`  ${parts.join("  ")}`);

  // --- Previous Batches ---
  renderBatchHistory();

  console.log(chalk.gray(`\n  State file: ${STATE_FILE}`));
  console.log(chalk.gray(`  Logs dir:   ${LOGS_DIR}`));
}

interface BatchLogSummary {
  filename: string;
  sent: number;
  received: number;
  hasError: boolean;
  timestamp: string; // from the first log line
}

function parseBatchLogs(): BatchLogSummary[] {
  if (!fs.existsSync(LOGS_DIR)) return [];

  const logFiles = fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith(".log"));
  const summaries: BatchLogSummary[] = [];

  for (const logFile of logFiles) {
    const content = fs.readFileSync(path.join(LOGS_DIR, logFile), "utf-8");
    const lines = content.split("\n");

    let sent = 0;
    let received = 0;
    let hasError = false;
    let timestamp = "";

    for (const line of lines) {
      if (!timestamp) {
        const match = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
        if (match) timestamp = match[1];
      }

      if (line.includes("Files sent:")) {
        const m = line.match(/Files sent:\s*(\d+)/);
        if (m) sent = parseInt(m[1], 10);
      }

      if (line.includes("RECEIVED:")) {
        received++;
      }

      if (line.includes("ERROR:")) {
        hasError = true;
      }
    }

    summaries.push({
      filename: logFile.replace(/\.log$/, ""),
      sent,
      received,
      hasError,
      timestamp,
    });
  }

  // Sort by timestamp descending (most recent first)
  summaries.sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1));

  return summaries;
}

function renderBatchHistory(): void {
  const summaries = parseBatchLogs();
  if (summaries.length === 0) return;

  console.log(chalk.bold(`\n  Previous Batches\n`));

  const header = `  ${"RESULT".padEnd(16)} ${"BATCH".padEnd(52)} ${"DATE"}`;
  console.log(chalk.gray(header));
  console.log(chalk.gray("  " + "─".repeat(90)));

  // Show last 20
  for (const s of summaries.slice(0, 20)) {
    const ratio = `${s.sent}/${s.received}`;
    let resultStr: string;
    if (s.hasError) {
      resultStr = chalk.red(`${ratio} ⚠ ERR`);
    } else if (s.received < s.sent) {
      resultStr = chalk.yellow(`${ratio} partial`);
    } else {
      resultStr = chalk.green(`${ratio} ✓`);
    }
    // Pad with extra space for ANSI codes
    const padded = resultStr + " ".repeat(Math.max(0, 16 - ratio.length - (s.hasError ? 6 : s.received < s.sent ? 8 : 2)));

    const name = s.filename.length > 50 ? "…" + s.filename.slice(-49) : s.filename;
    const date = s.timestamp ? new Date(s.timestamp).toLocaleString() : "—";

    console.log(`  ${padded} ${name.padEnd(52)} ${date}`);
  }

  if (summaries.length > 20) {
    console.log(chalk.gray(`  ... and ${summaries.length - 20} more (see ${LOGS_DIR})`));
  }
}

render();
setInterval(render, REFRESH_INTERVAL);
