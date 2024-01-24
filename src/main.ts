import { config } from "./config";
import watcher from "@parcel/watcher";
import fs from "node:fs";
import path from "path";
import { execSync } from "child_process";

let dropletProcessRunning = false;

async function main() {
  console.log("Starting watcher");

  const subscription = await watcher.subscribe(
    config.GARMENT_WATCH_PATH,
    async (err, events) => {
      console.log("new event detected", events);

      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const stat = fs.lstatSync(event.path);

        if (event.type === "create" || event.type === "update") {
          if (stat.isFile()) {
            console.log("New file detected, ", event.path);

            const result = execSync(
              `open -a ${config.GARMENT_FILTER_APP.replace(/(\s+)/g, "\\$1")} ${event.path.replace(/(\s+)/g, "\\$1")}`,
            );

            await sleep(1000);

            const outputPath =
              `/Users/inimini/Dropbox/MINIKIT PHOTO/NYA PLAGG/_PNG/${path.posix.basename(event.path)}`.replace(
                /(\s+)/g,
                "\\$1",
              );

            //console.log("Waiting for file to be created:", outputPath);
            //await checkFileExist(outputPath);
          }
        }
      }
    },
  );

  await watcher.subscribe(config.GARMENT_PS_WATCH_PATH, async (err, events) => {
    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      if (event.type === "create") {
        const filename = path.posix
          .basename(event.path)
          .replace(".png", ".jpg");

        const oldPath = path.join(config.GARMENT_WATCH_PATH, filename);
        const newPath = path.join(config.GARMENT_OUT_PATH, filename);

        const stat = fs.lstatSync(oldPath);
        if (stat.isFile()) {
          console.log("Moving ", oldPath, " to ", newPath);
          //fs.renameSync(oldPath, newPath);
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
