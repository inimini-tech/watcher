import { log } from "./logging";

const UPLOAD_LIMIT = 100;
const UPLOAD_WINDOW_MS = 60_000;
const timestamps: number[] = [];

export async function waitForUploadSlot(): Promise<void> {
  const now = Date.now();

  while (timestamps.length > 0 && timestamps[0] < now - UPLOAD_WINDOW_MS) {
    timestamps.shift();
  }

  if (timestamps.length < UPLOAD_LIMIT) {
    timestamps.push(Date.now());
    return;
  }

  const waitMs = timestamps[0] - (now - UPLOAD_WINDOW_MS) + 50;
  log(`Rate limit reached (${UPLOAD_LIMIT}/min), waiting ${Math.round(waitMs / 1000)}s`, "WARNING");

  return new Promise((resolve) => {
    setTimeout(() => {
      waitForUploadSlot().then(resolve);
    }, waitMs);
  });
}
