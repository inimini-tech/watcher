import "dotenv/config";
import { config } from "./config";
import watcher from "@parcel/watcher";
import fs from "node:fs";
import path from "path";
import { execSync } from "child_process";
import { Storage } from "@google-cloud/storage";

const storage = new Storage({
  projectId: process.env.PROJECT_ID,
  credentials: require("../key.json"),
});

async function main() {
  console.log("Starting watcher");

  const subscription = await watcher.subscribe(
    config.GARMENT_WATCH_PATH,
    async (err, events) => {
      console.log("new event detected", events);

      for (let i = 0; i < events.length; i++) {
        const event = events[i];

        if (event.type === "create" || event.type === "update") {
          const stat = fs.lstatSync(event.path);
          if (stat.isFile()) {
            console.log("New file detected, ", event.path);

            execSync(
              `open -a ${config.GARMENT_FILTER_APP.replace(/(\s+)/g, "\\$1")} ${event.path.replace(/(\s+)/g, "\\$1")}`,
            );

            await sleep(1000);
          }
        }
      }
    },
  );

  await watcher.subscribe(config.GARMENT_PS_WATCH_PATH, async (err, events) => {
    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      if (event.type === "create") {
        const id = path.parse(path.posix.basename(event.path)).name;
        const filename = path.posix
          .basename(event.path)
          .replace(".png", ".jpg");

        const oldPath = path.join(config.GARMENT_WATCH_PATH, filename);
        const newPath = path.join(config.GARMENT_OUT_PATH, filename);

        if (fs.existsSync(oldPath)) {
          try {
            console.log(`Moving [${id}]`, oldPath, " to ", newPath);
            fs.renameSync(oldPath, newPath);
          } catch (err: any) {
            console.log(err.message);
            console.log("Error while moving file");
          }
        }

        try {
          await uploadFileToBucket(event.path);
          await fetch(`${process.env.API_URL}/api/processed?id=${id}`);
        } catch (err) {
          console.log("Error when uploading to bucket");
        }
      }
    }
  });
}
async function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function uploadFileToBucket(filepath: string) {
  try {
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
      public: true,
      metadata: {
        contentType: "application/plain",
      },
    });

    console.log(`File uploaded`);

    const filename = path.posix.basename(filepath);
    const newPath = path.join(config.GARMENT_COMPLETED_OUT_PATH, filename);

    fs.renameSync(filepath, newPath);
  } catch (error: any) {
    console.log(error);
    throw new Error(error.message);
  }
}

async function checkFileExist(path: string, timeout = 2000) {
  let totalTime = 0;
  let checkTime = timeout / 10;

  return await new Promise((resolve, reject) => {
    const timer = setInterval(function () {
      totalTime += checkTime;

      let fileExists = fs.existsSync(path);

      if (fileExists || totalTime >= timeout) {
        clearInterval(timer);

        resolve(fileExists);
      }
    }, checkTime);
  });
}

main();
