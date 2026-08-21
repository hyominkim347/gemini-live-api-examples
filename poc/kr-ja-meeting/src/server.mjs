import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4173);
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
]);

function resolveRequest(pathname) {
  if (pathname === "/") return join(root, "public", "index.html");
  const relativePath = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  if (!relativePath.startsWith("public/") && !relativePath.startsWith("src/")) {
    return null;
  }
  const resolved = join(root, relativePath);
  return resolved.startsWith(root) ? resolved : null;
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const filePath = resolveRequest(pathname);
  if (!filePath) {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Type": contentTypes.get(extname(filePath)) ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`KR-JA meeting tracer: http://${host}:${port}`);
});
