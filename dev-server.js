// Local development server: serves ./public and routes /api/* to the same handler Vercel uses.
// Run with: node dev-server.js (or npm start) (credentials from GOOGLE_CREDENTIALS or the local credentials.json)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { handleApi } = require("./backend");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(pathname, res) {
  if (pathname === "/") pathname = "/index.html";
  const file = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(req, res);
    serveStatic(pathname, res);
  })
  .listen(PORT, () => console.log(`Flashcards running at http://localhost:${PORT}`));
