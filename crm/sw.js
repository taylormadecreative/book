// Installable shell only. Client records, credentials and API responses are never cached.
self.addEventListener(
  "install",
  (event) => event.waitUntil(self.skipWaiting()),
);
self.addEventListener(
  "activate",
  (event) => event.waitUntil(self.clients.claim()),
);
