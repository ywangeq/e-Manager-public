import http from "node:http";

// Immutable release bridge: deliberately imports no application or persistence
// modules. It is also the data-preserving rollback target after schema activation.
const worker = process.argv.includes("--worker");
const message = "数字中心正在更新，请稍后刷新。已保存的任务与记录不会被删除。";
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>数字中心更新中</title><body style="font:16px system-ui;margin:12vh auto;padding:24px;max-width:560px;color:#202124;background:#f8fafd"><h1>数字中心更新中</h1><p>${message}</p></body></html>`;
if (worker) {
  const keepAlive = setInterval(() => {}, 60000);
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { clearInterval(keepAlive); });
} else {
  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, service: "digital-workforce-auth", mode: "maintenance" }));
    }
    res.setHeader("Retry-After", "60");
    if (req.url?.startsWith("/api/")) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "center_release_maintenance", message }));
    }
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  server.listen(Number(process.env.AUTH_SERVER_PORT || 8787), process.env.AUTH_SERVER_HOST || "127.0.0.1");
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close());
}
