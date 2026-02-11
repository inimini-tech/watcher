import "dotenv/config";
import fs from "node:fs";
import path from "path";
import chalk from "chalk";
import type { BatchJobState } from "./agents";

const STATE_FILE = path.join(__dirname, "..", "agents-state.json");
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
  console.log(chalk.gray(`\n  State file: ${STATE_FILE}`));
}

render();
setInterval(render, REFRESH_INTERVAL);
