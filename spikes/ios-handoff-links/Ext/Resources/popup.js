const S = "bsvbridgespike://approve?id=123";
const U = "https://deggen.ngrok.app/approve?id=123";
const api = typeof browser !== "undefined" ? browser : chrome;
const log = (m) => {
  document.getElementById("log").textContent += m + "\n";
  fetch("https://deggen.ngrok.app/log?m=" + encodeURIComponent("popup: " + m)).catch(() => {});
};
document.getElementById("b1").onclick = () =>
  api.tabs.create({ url: S }).then(() => log("tabs.create ok"), (e) => log("tabs.create err " + e));
document.getElementById("b2").onclick = () => { const w = window.open(S); log("window.open -> " + w); };
document.getElementById("b3").onclick = () => { log("location.href"); location.href = S; };
document.getElementById("b4").onclick = () =>
  api.runtime.sendMessage({ open: S }).then((r) => log("bg " + JSON.stringify(r)), (e) => log("bg err " + e));
document.getElementById("b5").onclick = () =>
  api.tabs.create({ url: U }).then(() => log("tabs.create U ok"), (e) => log("err " + e));
log("popup loaded");
