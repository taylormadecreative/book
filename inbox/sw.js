/* Taylormade Inbox — service worker: push + notification click only. No caching. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (_) { m = { title: "Taylormade Inbox", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(m.title || "Taylormade Inbox", {
    body: m.body || "",
    tag: m.tag || "inbox",
    renotify: true,
    icon: "/assets/img/inbox-192.png",
    badge: "/assets/img/inbox-192.png",
    data: { url: m.url || "/inbox/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/inbox/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if (w.url.includes("/inbox/")) { return w.navigate(url).then((c) => (c || w).focus()); }
    }
    return self.clients.openWindow(url);
  }));
});
