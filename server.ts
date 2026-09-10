import { createServer } from "node:http";
import { analyzeToken } from "./src/index.js";
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const address = url.searchParams.get("address")?.trim() ?? "";
  if (req.method !== "GET" || url.pathname !== "/analyze" || !/^0x[a-fA-F0-9]{40}$/.test(address)) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "INVALID_REQUEST" })); return; }
  try { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(await analyzeToken(address))); } catch { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "ANALYSIS_FAILED" })); }
});
server.listen(Number(process.env.PORT ?? 8787), "127.0.0.1", () => console.log("LP Oracle API listening"));
