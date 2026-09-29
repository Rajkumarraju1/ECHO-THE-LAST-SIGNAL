import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, "dist");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = join(root, normalize(relative));
  if (!file.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const details = await stat(file);
    if (!details.isFile()) throw new Error("not a file");
    response.writeHead(200, { "content-type": contentTypes[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(5173, "127.0.0.1", () => console.log("ECHO web preview at http://127.0.0.1:5173"));
