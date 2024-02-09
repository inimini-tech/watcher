import "dotenv/config";
import { config } from "./config";
import watcher from "@parcel/watcher";
import fs from "node:fs";
import path from "path";
import { execSync } from "child_process";
import { Storage } from "@google-cloud/storage";
import { shortPath, log } from "./logging";

let ps = false;

const storage = new Storage({
  projectId: process.env.PROJECT_ID,
  credentials: require("../key.json"),
});

async function main() {
  log("Starting watcher", "NOTICE");
  checkFolder();

  await watcher.subscribe(config.GARMENT_PS_WATCH_PATH, async (err, events) => {
    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      if (event.type === "create") {
        ps = false;

        await checkFileSize(event.path, async () => {
          log(`File ${shortPath(event.path)} has been synced`);

          const id = path.parse(path.posix.basename(event.path)).name;
          const filename = path.posix
            .basename(event.path)
            .replace(".png", ".jpg");

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
            await uploadFileToBucket(event.path);
            await fetch(`${process.env.API_URL}/api/processed?id=${id}`);
          } catch (err) {
            log(`Could not upload file to bucket`, "ERROR");
          }
        });
      }
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
        .map(
          (filePath) =>
            `"${path.join(config.GARMENT_PS_PROCESS_PATH, path.basename(filePath))}"`,
        )
        .join(" ");

      execSync(
        `open -a ${config.GARMENT_FILTER_APP.replace(/(\s+)/g, "\\$1")} ${fullPathString}`,
      );
    }
  }, 10000);
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

  filenames.forEach((filename) => {
    const filePath = path.join(folderPath, filename);
    const stats = fs.statSync(filePath);
    if (stats.size > 0 && stats.isFile()) {
      const extension = path.extname(filePath).toLowerCase();
      if (extension === ".jpg" || extension === ".jpeg") {
        files.push(filePath);
      }
    }
  });

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
