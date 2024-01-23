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
      events.map(async (event) => {
        const stat = await fs.lstatSync(event.path);

        if (stat.isFile()) {
          console.log("New file detected, ", event.path);

          const result = execSync(
            `open -a ${config.GARMENT_FILTER_APP.replace(/(\s+)/g, "\\$1")} ${event.path.replace(/(\s+)/g, "\\$1")}`,
          );

          console.log(result);

          //const newPath = `${config.GARMENT_OUT_PATH}/${path.posix.basename(event.path)}`;
          //fs.renameSync(event.path, newPath);
        }
      });
    },
  );
}

main();
