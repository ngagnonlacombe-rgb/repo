// Service worker : affiche les notifications envoyées par le serveur et ouvre l'app au bon endroit quand on les touche.
self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data.json(); } catch { m = { corps: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(m.titre || 'Vapro GUS', {
    body: m.corps || '', icon: '/logo-gus-192.png', badge: '/logo-gus-192.png', data: { url: m.url || '/' }, tag: m.url, renotify: true,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const fenetres = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const ouverte = fenetres.find((f) => new URL(f.url).origin === self.location.origin);
    if (ouverte) { await ouverte.focus(); return ouverte.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
