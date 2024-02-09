import chalk from "chalk";
import path from "path";
const error = chalk.bold.red;
const warning = chalk.hex("#FFA500");
const notice = chalk.cyan;

export function log(string: string, type?: "ERROR" | "WARNING" | "NOTICE") {
  switch (type) {
    case "ERROR":
      console.log(error(`ERROR: ${string}`));
      break;
    case "WARNING":
      console.log(warning(`WARNING: ${string}`));
      break;
    case "NOTICE":
      console.log(notice(`NOTICE: ${string}`));
      break;
    default:
      console.log(string);
      break;
  }
}

export function shortPath(filePath: string) {
  const fileName = path.basename(filePath);
  const parentFolder = path.basename(path.dirname(filePath));

  return path.join(parentFolder, fileName);
}
