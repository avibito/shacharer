// שחרר — offline support. Network first (so updates arrive immediately), cache as fallback.
const CACHE = 'shacharer-v18-4';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './config.json', './shacharer-icon-192.png', './shacharer-icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // Harness QA Inspector is a separate tool that lives in the same site; leave its requests alone.
  if (url.pathname.includes('/harness-qa/') || url.pathname.endsWith('/harness_qa_engineering_demo_v33.html')) return;
  e.respondWith(
    // Bypass the browser HTTP cache (GitHub Pages sets max-age=600) so a new version shows up at once.
    fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })
      .then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
