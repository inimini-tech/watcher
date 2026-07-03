import "dotenv/config";
import { config } from "./config";
import watcher from "@parcel/watcher";
import fs from "node:fs";
import path from "path";
import { execSync } from "child_process";
import { Storage } from "@google-cloud/storage";
import { shortPath, log } from "./logging";
import { startAgentsWatcher } from "./agents";
import { waitForUploadSlot } from "./rate-limiter";

let ps = false;

const storage = new Storage({
  projectId: process.env.PROJECT_ID,
  credentials: require("../key.json"),
});

// Tracks PNG files currently being processed so the event watcher and the
// periodic sweep don't pick up the same file twice.
const processingPngs = new Set<string>();

const PNG_SWEEP_INTERVAL_MS = 30_000; // 30 seconds

async function main() {
  log("Starting watcher", "NOTICE");
  checkFolder();
  checkWorkFolder();
  if (process.env.ENABLE_AGENTS === "true") {
    startAgentsWatcher();
  }

  // Live event watcher for low-latency handling of new PNGs.
  await watcher.subscribe(config.GARMENT_PS_WATCH_PATH, async (err, events) => {
    if (err) {
      log(`PNG watcher error: ${err.message}`, "ERROR");
      return;
    }
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.type === "create") {
        handlePngFile(event.path);
      }
    }
  });

  // Fallback sweep: @parcel/watcher only reports events that happen while it is
  // running, so it never sees files already in _PNG at startup and can miss
  // events on Dropbox-synced folders. Scan for leftover PNGs on an interval.
  scanPngFolder();
  setInterval(scanPngFolder, PNG_SWEEP_INTERVAL_MS);
}

function scanPngFolder() {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(config.GARMENT_PS_WATCH_PATH);
  } catch (err: any) {
    log(`Could not read PNG watch folder: ${err.message}`, "ERROR");
    return;
  }

  const pngFiles = filenames.filter(
    (f) => !f.startsWith(".") && path.extname(f).toLowerCase() === ".png",
  );

  const pending = pngFiles.filter((f) => {
    const filePath = path.join(config.GARMENT_PS_WATCH_PATH, f);
    return !processingPngs.has(filePath);
  });

  if (pending.length > 0) {
    log(`Sweep found ${pending.length} unprocessed PNG file(s) in _PNG`, "NOTICE");
    for (const filename of pending) {
      handlePngFile(path.join(config.GARMENT_PS_WATCH_PATH, filename));
    }
  }
}

function handlePngFile(filePath: string) {
  if (processingPngs.has(filePath)) return;
  processingPngs.add(filePath);
  ps = false;

  checkFileSize(filePath, async () => {
    try {
      log(`File ${shortPath(filePath)} has been synced`);

      const id = path.parse(path.posix.basename(filePath)).name;
      const filename = path.posix.basename(filePath).replace(".png", ".jpg");

      const oldPath = path.join(config.GARMENT_PS_PROCESS_PATH, filename);
      const newPath = path.join(config.GARMENT_OUT_PATH, filename);

      if (fs.existsSync(oldPath)) {
        try {
          fs.renameSync(oldPath, newPath);
        } catch (err: any) {
          log(`Could not rename file`, "ERROR");
          log(err.message, "ERROR");
        }
      }

      try {
        await waitForUploadSlot();
        await uploadFileToBucket(filePath);
        await fetch(`${process.env.API_URL}/api/processed?id=${id}`);
      } catch (err) {
        log(`Could not upload file to bucket`, "ERROR");
      }
    } finally {
      processingPngs.delete(filePath);
    }
  });
}

function checkFolder() {
  setInterval(() => {
    if (countJpegFiles(config.GARMENT_PS_PROCESS_PATH) > 0) {
      return;
    }

    const files = getNonEmptyFiles(config.GARMENT_WATCH_PATH);
    if (files.length > 0) {
      log(`${files.length} files to be processed`, "NOTICE");
      files.forEach((filePath: string) => {
        const filename = path.basename(filePath);
        const sanitizedFileName = filename.startsWith(".")
          ? filename.substring(1)
          : filename;
        const newPath = path.join(
          config.GARMENT_PS_PROCESS_PATH,
          sanitizedFileName,
        );
        fs.renameSync(filePath, newPath);
      });

      const fullPathString = files
        .map((filePath) => {
          const fileName = path.basename(filePath);
          const sanitizedFileName = fileName.startsWith(".")
            ? fileName.substring(1)
            : fileName;
          return `"${path.join(config.GARMENT_PS_PROCESS_PATH, sanitizedFileName)}"`;
        })
        .join(" ");

      execSync(
        `open -a ${config.GARMENT_FILTER_APP.replace(/(\s+)/g, "\\$1")} ${fullPathString}`,
      );
    }
  }, 10000);
}

function checkWorkFolder() {
  setInterval(
    () => {
      const currentTimestamp = Date.now();
      const files = fs.readdirSync(config.GARMENT_PS_PROCESS_PATH);
      const jpgFiles = files.filter(
        (file) => path.extname(file).toLowerCase() === ".jpg",
      );

      if (jpgFiles.length > 0) {
        log(
          `${jpgFiles.length} files older than 1 hour detected, attempting to move to watch folder.`,
          "WARNING",
        );

        try {
          jpgFiles.forEach((file) => {
            const filePath = path.join(config.GARMENT_PS_PROCESS_PATH, file);
            const stats = fs.statSync(filePath);
            const fileAgeInHours =
              (currentTimestamp - stats.mtimeMs) / (1000 * 60 * 60);
            if (fileAgeInHours > 1) {
              const oldPath = path.join(config.GARMENT_PS_PROCESS_PATH, file);
              const newPath = path.join(config.GARMENT_WATCH_PATH, file);
              fs.renameSync(oldPath, newPath);
            }
          });

          log(`Moved ${jpgFiles.length} files back to watch folder.`, "NOTICE");

          const photoshopProcessName = "Adobe Photoshop";
          const psProcess = execSync(
            `ps aux | grep "${photoshopProcessName}" | grep -v grep`,
          ).toString();
          if (psProcess) {
            const psProcessLines = psProcess.split("\n");
            psProcessLines.forEach((line) => {
              const processInfo = line.trim().split(/\s+/);
              const pid = processInfo[1];
              if (pid) {
                execSync(`kill -9 ${pid}`);
                log(
                  `Killed process ${pid} for ${photoshopProcessName}`,
                  "NOTICE",
                );
              }
            });
          }
        } catch (moveError: any) {
          log(`Failed to move .jpg files: ${moveError.message}`, "ERROR");
        }
      }
    },
    1000 * 60 * 30, // Check every 30 min
  );
}

function countJpegFiles(folderPath: string): number {
  let jpegCount = 0;

  const filenames = fs.readdirSync(folderPath);
  filenames.forEach((filename) => {
    const filePath = path.join(folderPath, filename);
    const stats = fs.statSync(filePath);
    if (stats.isFile()) {
      const extension = path.extname(filePath).toLowerCase();
      if (extension === ".jpg" || extension === ".jpeg") {
        jpegCount++;
      }
    }
  });

  return jpegCount;
}

function getNonEmptyFiles(folderPath: string): string[] {
  const files: string[] = [];
  const filenames = fs.readdirSync(folderPath);

  for (const filename of filenames) {
    if (files.length >= 40) break;
    const filePath = path.join(folderPath, filename);
    const stats = fs.statSync(filePath);
    if (stats.size > 0 && stats.isFile()) {
      const extension = path.extname(filePath).toLowerCase();
      if (extension === ".jpg" || extension === ".jpeg") {
        files.push(filePath);
      }
    }
  }

  return files;
}

async function checkFileSize(
  filePath: string,
  callback: () => void,
  interval: number = 5000,
) {
  const fileSizeTimer = setInterval(async () => {
    const stats = fs.statSync(filePath);
    if (stats.size > 0) {
      clearInterval(fileSizeTimer);
      callback();
    } else {
      log(
        `File ${shortPath(filePath)} is not synced to dropbox yet...`,
        "NOTICE",
      );
    }
  }, interval);
}

async function uploadFileToBucket(filepath: string) {
  try {
    const stats = fs.statSync(filepath);
    const fileSizeInBytes = stats.size;

    const fileName = path.posix.basename(filepath);
    const gcs = storage.bucket("gs://minikit-images-garments");
    const storagepath = `${fileName}`;

    let contentType = "";
    const fileExtension = filepath.split(".").pop();

    switch (fileExtension) {
      case "jpg":
      case "jpeg":
        contentType = "image/jpeg";
        break;
      case "png":
        contentType = "image/png";
        break;
      case "gif":
        contentType = "image/gif";
        break;
      default:
        contentType = "application/octet-stream";
    }

    const result = await gcs.upload(filepath, {
      destination: storagepath,
      metadata: {
        contentType,
      },
    });

    const filename = path.posix.basename(filepath);
    const newPath = path.join(config.GARMENT_COMPLETED_OUT_PATH, filename);

    fs.renameSync(filepath, newPath);

    log(
      `Succesfully uploaded ${shortPath(filepath)} (${Math.round(fileSizeInBytes / 1024)}kb)`,
      "NOTICE",
    );
  } catch (error: any) {
    log("Error during upload", "ERROR");
    console.log(error.message);
    throw new Error(error.message);
  }
}

main();
