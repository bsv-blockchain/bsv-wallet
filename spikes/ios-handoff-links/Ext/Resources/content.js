const api = typeof browser !== "undefined" ? browser : chrome;
const log = (m) => fetch("http://localhost:3000/log?m=" + encodeURIComponent("content: " + m)).catch(() => {});
log("content script loaded " + location.href);
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.spike !== true) return;
  const v = e.data.variant;
  const url = "bsvbridgespike://approve?id=" + v + Date.now();
  log("message variant=" + v + " isTrusted=" + e.isTrusted + " activation=" + (navigator.userActivation ? navigator.userActivation.isActive : "n/a"));
  if (v === "C1") { log("C1 location.href"); location.href = url; return; }
  if (v === "C2") { log("C2 anchor click"); const a = document.createElement("a"); a.href = url; document.body.appendChild(a); a.click(); a.remove(); return; }
  api.runtime.sendMessage({ variant: v, url }).then((r) => log("bg reply " + JSON.stringify(r)), (er) => log("bg err " + er));
});
