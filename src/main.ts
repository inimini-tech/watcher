import { config } from "./config";
import watcher from "@parcel/watcher";
import fs from "node:fs";
import path from "path";

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
              const newPath = `${config.GARMENT_OUT_PATH}/${path.posix.basename(event.path)}`;
              fs.renameSync(event.path, newPath);
            }
          }
        }),
      );
    },
  );
}

main();
