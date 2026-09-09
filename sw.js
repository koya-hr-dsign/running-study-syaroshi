/* sw.js — オフラインで使えるようにアプリ本体をキャッシュする */
const VERSION = 'v3';
const CACHE = 'sharoushi-' + VERSION;
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/store.js',
  './js/voice.js',
  './js/gemini.js',
  './js/sync.js',
  './js/firebase-config.js',
  './js/app.js',
  './data/index.json',
  './data/labor-standards.json',
  './data/safety.json',
  './data/rousai.json',
  './data/koyou.json',
  './data/chousyu.json',
  './data/roudou-ippan.json',
  './data/shakai-ippan.json',
  './data/kenpo.json',
  './data/kounen.json',
  './data/kokunen.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Web フォントはオフラインでも効くようキャッシュ優先で持つ
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // Gemini API など、それ以外の外部への通信はキャッシュを介さない
  if (url.origin !== self.location.origin) return;

  // アプリ本体は「まずネットワーク、駄目ならキャッシュ」。
  // 更新をすぐ拾いつつ、オフラインでも起動できる。
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
