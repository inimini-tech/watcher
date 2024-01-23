import { defineConfig } from "tsup";

const isProduction = process.env.NODE_ENV === "production";

export default defineConfig({
  clean: true,
  dts: true,
  target: "node18",
  entry: ["src/main.ts"],
  format: ["cjs", "esm"],
  minify: isProduction,
  sourcemap: true,
});
