import fs from "node:fs";
import path from "node:path";

// Opt-in local test hosting only. Production continues to use its release Nginx.
export function createLocalTestFrontend({ enabled = false, directory } = {}) {
  if (!enabled) return () => false;
  const root = fs.realpathSync(directory);
  const files = new Map();
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".ico": "image/x-icon" };
  function collect(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory() && (relative === "assets" || relative.startsWith("assets/"))) collect(path.join(dir, entry.name), relative + "/");
      else if (entry.isFile() && (relative === "index.html" || relative.startsWith("assets/")) && types[path.extname(relative)]) {
        files.set("/" + relative, { file: path.join(root, relative), type: types[path.extname(relative)] });
      }
    }
  }
  collect(root);
  if (!files.has("/index.html")) throw new Error("local_test_frontend_build_required");
  files.set("/", files.get("/index.html"));
  return (req, res, url) => {
    if (!["GET", "HEAD"].includes(req.method)) return false;
    const item = files.get(url.pathname);
    if (!item) return false;
    // Recheck containment if a build file is replaced after startup.
    const actual = fs.realpathSync(item.file);
    if (actual !== item.file) return false;
    const bytes = fs.readFileSync(actual);
    res.writeHead(200, { "Content-Type": item.type, "Content-Length": bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : bytes);
    return true;
  };
}
