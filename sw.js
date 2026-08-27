/* SIMS — service worker
   Tiga tugas: menyimpan kerangka aplikasi supaya tetap terbuka saat sinyal
   putus, memunculkan pemberitahuan, dan membangunkan diri secara berkala di
   Android untuk menarik pemberitahuan baru dari Apps Script.

   Batas yang perlu diketahui sejak awal. Apps Script tidak dapat mengirim
   Web Push sungguhan, karena penandatanganan VAPID memakai ECDSA P-256 yang
   tidak tersedia di Utilities. Jadi yang berjalan di sini adalah penarikan
   berkala, bukan dorongan dari peladen. Di Android dengan aplikasi yang sudah
   dipasang, periodicsync bangun tiap beberapa jam. Di iOS jalur itu tidak ada
   sama sekali, sehingga pemberitahuan hanya muncul selama aplikasi terbuka. */

/* Nama simpanan dinaikkan setiap kali aturan di berkas ini berubah, supaya
   simpanan lama dibuang saat pengaktifan. Berkas di /assets/ tidak perlu
   didaftarkan karena namanya sudah membawa sidik isi dan disimpan lewat jalur
   biasa di bawah. */
const CACHE = 'sims-v3';
const KERANGKA = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(KERANGKA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x))))
      .then(() => self.clients.claim())
  );
});

/* Aturan simpanan dipisah menurut jenis berkas, karena keduanya punya sifat
   yang berlawanan.

   Berkas di /assets/ namanya membawa sidik jari isi, jadi nama yang sama pasti
   isinya sama selamanya. Berkas itu aman diambil dari simpanan lebih dulu.

   Kerangka index.html sebaliknya. Namanya tidak pernah berubah padahal isinya
   berubah setiap kali dibangun, dan di dalamnya ada penunjuk ke berkas assets
   yang baru. Kalau kerangka disajikan dari simpanan lebih dulu, pembaruan
   tidak akan pernah terlihat sampai simpanan dibersihkan manual. Karena itu
   kerangka selalu diambil dari jaringan lebih dulu, dan simpanan hanya dipakai
   ketika jaringan benar-benar tidak bisa dihubungi. */
function dariJaringanDulu(req) {
  return fetch(req).then(res => {
    if (res && res.status === 200) {
      const salin = res.clone();
      caches.open(CACHE).then(c => c.put(req, salin));
    }
    return res;
  }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')));
}

function dariSimpananDulu(req) {
  return caches.match(req).then(r => r || fetch(req).then(res => {
    if (res && res.status === 200 && res.type === 'basic') {
      const salin = res.clone();
      caches.open(CACHE).then(c => c.put(req, salin));
    }
    return res;
  }));
}

self.addEventListener('fetch', ev => {
  const u = new URL(ev.request.url);
  if (ev.request.method !== 'GET') return;
  if (u.origin !== self.location.origin) return;

  const kerangka = ev.request.mode === 'navigate' ||
                   u.pathname === '/' ||
                   u.pathname.endsWith('/index.html');
  ev.respondWith(kerangka ? dariJaringanDulu(ev.request) : dariSimpananDulu(ev.request));
});

/* ---------- titipan token dari halaman ---------- */
const KUNCI = 'sims-cfg';
function simpanCfg(cfg) {
  return caches.open(KUNCI).then(c =>
    c.put('/cfg', new Response(JSON.stringify(cfg), {headers: {'Content-Type': 'application/json'}})));
}
function bacaCfg() {
  return caches.open(KUNCI)
    .then(c => c.match('/cfg'))
    .then(r => (r ? r.json() : null))
    .catch(() => null);
}

self.addEventListener('message', ev => {
  const d = ev.data || {};
  if (d.jenis === 'sesi') simpanCfg({url: d.url || '/api', aktif: d.aktif !== false});
  if (d.jenis === 'tampilkan') {
    self.registration.showNotification(d.judul || 'SIMS', {
      body: d.isi || '', icon: './icon-192.png', badge: './icon-192.png',
      tag: d.tag || 'sims', data: {halaman: d.halaman || 'dash'}
    });
  }
});

/* ---------- menarik pemberitahuan baru ---------- */
function tarikNotif() {
  return bacaCfg().then(cfg => {
    if (!cfg || !cfg.url || cfg.aktif === false) return;
    /* Kuki sesi ikut terbawa karena permintaannya satu asal, jadi tidak ada
       token yang perlu disimpan di sini. */
    return fetch(cfg.url, {
      credentials: 'same-origin',
      method: 'POST',
      redirect: 'follow',
      headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: JSON.stringify({fn: 'apiNotifBaru', args: [null, cfg.sejak || '']})
    })
      .then(r => r.json())
      .then(r => {
        if (!r || !r.ok || !r.data) return;
        const d = r.data;
        if (!d.jumlah) return;
        cfg.sejak = d.sampai || cfg.sejak;
        return simpanCfg(cfg).then(() =>
          self.registration.showNotification('SIMS', {
            body: d.jumlah === 1 && d.teks ? d.teks : d.jumlah + ' pemberitahuan baru',
            icon: './icon-192.png', badge: './icon-192.png', tag: 'sims-notif',
            data: {halaman: d.halaman || 'dash'}
          }));
      })
      .catch(() => {});
  });
}

self.addEventListener('periodicsync', ev => {
  if (ev.tag === 'sims-notif') ev.waitUntil(tarikNotif());
});
self.addEventListener('sync', ev => {
  if (ev.tag === 'sims-notif') ev.waitUntil(tarikNotif());
});

/* Dipasang sekarang supaya kalau nanti ada peladen yang benar-benar bisa
   mendorong Web Push, jalurnya sudah siap tanpa mengubah berkas ini. */
self.addEventListener('push', ev => {
  let d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch (e) { d = {isi: ev.data ? ev.data.text() : ''}; }
  ev.waitUntil(self.registration.showNotification(d.judul || 'SIMS', {
    body: d.isi || '', icon: './icon-192.png', badge: './icon-192.png',
    tag: d.tag || 'sims', data: {halaman: d.halaman || 'dash'}
  }));
});

/* Ketukan pemberitahuan membuka jendela yang sudah ada bila ada, lalu
   memindahkannya ke halaman yang bersangkutan lewat tanda pagar alamat. */
self.addEventListener('notificationclick', ev => {
  ev.notification.close();
  const halaman = (ev.notification.data && ev.notification.data.halaman) || 'dash';
  ev.waitUntil(
    self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
      for (const c of list) {
        if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
          c.postMessage({jenis: 'buka', halaman: halaman});
          return c.focus();
        }
      }
      return self.clients.openWindow('./index.html#/' + halaman);
    })
  );
});
