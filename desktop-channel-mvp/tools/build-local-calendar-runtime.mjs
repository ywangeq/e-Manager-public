import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
await build({entryPoints:["electron/local-calendar-runtime-source.mjs"],outfile:"electron/local-calendar-runtime.bundle.mjs",
  bundle:true,platform:"node",format:"esm",target:"node24",packages:"external"});
