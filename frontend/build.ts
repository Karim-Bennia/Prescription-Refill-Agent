import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

/** A small local bundle; no server configuration or environment files enter the browser build. */
export async function buildFrontend() {
  const directory = new URL("dist/", import.meta.url);
  await mkdir(directory, { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL("src/main.tsx", import.meta.url))],
    outfile: fileURLToPath(new URL("app.js", directory)),
    bundle: true, platform: "browser", format: "iife", target: "es2022", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent", sourcemap: false, minify: true,
  });
  await copyFile(new URL("index.html", import.meta.url), new URL("index.html", directory));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await buildFrontend(); console.log("React TypeScript frontend built in frontend/dist."); }
  catch { console.error("Frontend build failed. Check dependencies and TypeScript source."); process.exitCode = 1; }
}
