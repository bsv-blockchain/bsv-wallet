const http = require("node:http");
const APP = process.env.APPID || "SV8SWTHA2H.tech.bsvb.spike.handoff";
http.createServer((q, r) => {
  console.log(new Date().toISOString(), q.method, q.url, "|", (q.headers["user-agent"] || "").slice(0, 70), "| ref:", q.headers.referer || "-");
  const p = q.url.split("?")[0];
  if (p === "/.well-known/apple-app-site-association") {
    r.setHeader("content-type", "application/json");
    return r.end(JSON.stringify({ applinks: { details: [{ appIDs: [APP], components: [{ "/": "/approve*" }], paths: ["/approve*"] }] } }));
  }
  if (p === "/log") { r.setHeader("access-control-allow-origin", "*"); return r.end("ok"); }
  r.setHeader("content-type", "text/html");
  r.end(`<!doctype html><meta name=viewport content="width=device-width"><h1>${p}</h1><p>${q.url}</p><p>${new Date().toISOString()}</p><p><a href="/approve?id=123">approve link</a> <a href="bsvbridgespike://approve?id=123">scheme link</a></p>`);
}).listen(3000, () => console.log("listening 3000"));
