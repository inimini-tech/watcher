import { config } from "./config";
import watcher from "@parcel/watcher";
import fs from "node:fs";
import path from "path";
import { exec } from "child_process";

async function main() {
  console.log("Starting watcher");
  const subscription = await watcher.subscribe(
    config.GARMENT_WATCH_PATH,
    async (err, events) => {
      console.log(events);

      await Promise.all(
        events.map(async (event) => {
          if (event.type === "create") {
            const stat = await fs.lstatSync(event.path);

            if (stat.isFile()) {
              console.log("New file created, ", event.path);

              exec(
                `open -a ${config.GARMENT_FILTER_APP.replace(/(\s+)/g, "\\$1")} ${event.path.replace(/(\s+)/g, "\\$1")}`,
                (error, stdout, stderr) => {
                  if (error) {
                    console.log(`error: ${error.message}`);
                    return;
                  }
                  if (stderr) {
                    console.log(`stderr: ${stderr}`);
                    return;
                  }
                  console.log(`stdout: ${stdout}`);
                },
              );

              //const newPath = `${config.GARMENT_OUT_PATH}/${path.posix.basename(event.path)}`;
              //fs.renameSync(event.path, newPath);
            }
          }
        }),
      );
    },
  );
}

main();
