const http = require("node:http");
const APP = process.env.APPID || "SV8SWTHA2H.tech.bsvb.spike.handoff";
http.createServer((q, r) => {
  console.log(new Date().toISOString(), q.method, q.url, "|", (q.headers["user-agent"] || "").slice(0, 70), "| ref:", q.headers.referer || "-");
  const p = q.url.split("?")[0];
  if (p === "/.well-known/apple-app-site-association") {
    r.setHeader("content-type", "application/json");
    return r.end(JSON.stringify({ applinks: { details: [{ appIDs: [APP], components: [{ "/": "/approve*" }], paths: ["/approve*"] }] } }));
  }
  if (p === "/log") { console.log("LOG", decodeURIComponent((q.url.split("m=")[1]||""))); r.setHeader("access-control-allow-origin", "*"); return r.end("ok"); }
  if (p === "/t") {
    r.setHeader("content-type", "text/html");
    return r.end(`<!doctype html><meta name=viewport content="width=device-width"><body style="font:18px sans-serif;padding:12px"><h2>Page-triggered test</h2><p id=s>loaded</p>
<p><button style="font-size:20px" onclick="go('A')">A: click -> bg create</button></p>
<p><button style="font-size:20px" onclick="go('C1')">C1: content location.href</button></p>
<p><button style="font-size:20px" onclick="go('C2')">C2: content anchor click</button></p>
<p><button style="font-size:20px" onclick="go('D')">D: click -> bg tabs.update</button></p>
<p><button style="font-size:20px" onclick="setTimeout(()=>go('B'),3000);this.textContent='B armed (3s)'">B: 3s timer -> bg create</button></p>
<script>if(location.search.includes('auto'))setTimeout(()=>go('B0'),3000);function go(v){window.postMessage({spike:true,variant:v},'*')}</script>`);
  }
  r.setHeader("content-type", "text/html");
  r.end(`<!doctype html><meta name=viewport content="width=device-width"><h1>${p}</h1><p>${q.url}</p><p>${new Date().toISOString()}</p><p><a href="/approve?id=123">approve link</a> <a href="bsvbridgespike://approve?id=123">scheme link</a></p>`);
}).listen(3000, () => console.log("listening 3000"));
