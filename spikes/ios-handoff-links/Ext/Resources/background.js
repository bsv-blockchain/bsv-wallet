const api = typeof browser !== "undefined" ? browser : chrome;
const log = (m) => fetch("http://localhost:3000/log?m=" + encodeURIComponent("bg: " + m)).catch(() => {});
api.runtime.onMessage.addListener((m, sender) => {
  if (m.open) return api.tabs.create({ url: m.open }).then(() => ({ ok: true }), (e) => ({ err: String(e) }));
  if (m.variant) {
    log("variant " + m.variant + " from tab " + (sender.tab && sender.tab.id));
    const p = m.variant === "D" ? api.tabs.update(sender.tab.id, { url: m.url }) : api.tabs.create({ url: m.url });
    return p.then((t) => { log("ok tab " + (t && t.id)); return { ok: true }; }, (e) => { log("err " + e); return { err: String(e) }; });
  }
});
