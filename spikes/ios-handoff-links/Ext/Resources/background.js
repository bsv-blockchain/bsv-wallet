const api = typeof browser !== "undefined" ? browser : chrome;
api.runtime.onMessage.addListener((m) => {
  if (m.open) return api.tabs.create({ url: m.open }).then(() => ({ ok: true }), (e) => ({ err: String(e) }));
});
