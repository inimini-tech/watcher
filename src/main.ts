import { config } from "./config";
import watcher from "@parcel/watcher";
import fs from "node:fs";
import path from "path";
import { execSync } from "child_process";

async function main() {
  console.log("Starting watcher");
  const subscription = await watcher.subscribe(
    config.GARMENT_WATCH_PATH,
    async (err, events) => {
      console.log("new event detected", events);

      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const stat = fs.lstatSync(event.path);

        if (stat.isFile()) {
          console.log("New file detected, ", event.path);

          const result = execSync(
            `open -a ${config.GARMENT_FILTER_APP.replace(/(\s+)/g, "\\$1")} ${event.path.replace(/(\s+)/g, "\\$1")}`,
          );

          const outputPath =
            `/Users/inimini/Dropbox/MINIKIT PHOTO/NYA PLAGG/_PNG/${path.posix.basename(event.path)}`.replace(
              /(\s+)/g,
              "\\$1",
            );

          console.log("Waiting for file to be created:", outputPath);
          await checkFileExist(outputPath);
          console.log("W");

          //const newPath = `${config.GARMENT_OUT_PATH}/${path.posix.basename(event.path)}`;
          //fs.renameSync(event.path, newPath);
        }
      }
    },
  );
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
