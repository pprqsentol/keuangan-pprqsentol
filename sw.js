const CACHE = 'keuangan-rq-v6';
const FILES = [
  './', './index.html', './styles.css', './app.js', './config.js', './manifest.json',
  './icon-192.png', './icon-512.png'
];
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e=>{
  e.respondWith(
    caches.match(e.request).then(cached=>{
      const fetchPromise = fetch(e.request).then(res=>{
        if(e.request.method==='GET' && res.ok){ caches.open(CACHE).then(c=>c.put(e.request, res.clone())); }
        return res;
      }).catch(()=>cached);
      return cached || fetchPromise;
    })
  );
});
