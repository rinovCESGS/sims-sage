/* SIMS — perantara satu asal ke Apps Script.
 *
 * Satu-satunya kode sisi peladen di penyebaran ini. Vercel menjadikan tiap
 * berkas di bawah /api sebagai fungsi peladen, dan itulah sebabnya folder ini
 * ada sementara berkas lain tetap di akar.
 *
 * Yang berubah dibanding jalur lama, dan alasannya:
 *
 *   1. Peramban tidak lagi memanggil script.google.com. Ia memanggil /api di
 *      alamatnya sendiri. Tidak ada lintas asal, jadi tidak ada permintaan
 *      pendahuluan, tidak ada jalur cadangan JSONP, dan alamat /exec tidak
 *      pernah sampai ke perangkat siapa pun.
 *   2. Token sesi tidak lagi disimpan di localStorage dan tidak pernah ikut
 *      tertulis di alamat. Ia tinggal di kuki bertanda tangan yang tidak dapat
 *      dibaca JavaScript, dan perantara ini yang menyisipkannya ke argumen
 *      pertama tiap panggilan.
 *   3. Panggilan yang aman diulang akan diulang di sini bila Apps Script
 *      menjawab 404 atau galat sesaat pada leg pengalihan. Itu keuntungan
 *      pokok pindah ke jalur ini.
 *
 * Kontrak ke Apps Script sengaja TIDAK diubah. Perantara ini tetap mengirim
 * {fn, args} persis seperti jembatan lama, jadi Code.gs tidak perlu disunting
 * dan deployment tidak perlu dinaikkan versinya.
 *
 * Variabel lingkungan yang wajib diisi di Vercel, Settings, Environment
 * Variables:
 *   SIMS_GAS_URL          alamat aplikasi web Apps Script, berakhiran /exec
 *   SIMS_SESSION_SECRET   teks acak panjang untuk menandatangani kuki sesi
 */

import crypto from 'node:crypto';

/* ── penyetelan ───────────────────────────────────────────────────────────── */

function env(nama, bawaan) {
  const v = process.env[nama];
  return v === undefined || v === '' ? bawaan : v;
}

export function config() {
  return {
    gasUrl      : String(env('SIMS_GAS_URL', '')).trim(),
    rahasia     : String(env('SIMS_SESSION_SECRET', '')),
    sesiJam     : Number(env('SIMS_SESSION_HOURS', 12)),
    maksGagal   : Number(env('SIMS_MAX_FAILED_LOGINS', 8)),
    kunciMenit  : Number(env('SIMS_LOCKOUT_MINUTES', 15)),
    cacheDetik  : Number(env('SIMS_CACHE_SECONDS', 6)),
    batasMs     : Number(env('SIMS_TIMEOUT_SECONDS', 50)) * 1000,
    unggahMs    : Number(env('SIMS_UPLOAD_TIMEOUT_SECONDS', 50)) * 1000,
    ulang       : Number(env('SIMS_RETRIES', 2)),
    kukiAman    : String(env('SIMS_COOKIE_SECURE', 'auto'))
  };
}

const KUKI_SESI = 'sims_sesi';   // bertanda tangan, tidak terbaca JavaScript
const KUKI_ADA  = 'sims_ada';    // penanda kosong, terbaca, hanya untuk antarmuka

/* Awalan ini dicocokkan antarmuka untuk menahan suntingan lokal lalu meminta
   pengguna masuk lagi. Jangan diterjemahkan ulang. */
const SESI_HABIS = 'SESI_HABIS Sesi Anda berakhir. Muat ulang halaman lalu masuk lagi.';

/* Panggilan yang boleh diulang tanpa risiko berjalan dua kali.
 *
 * Daftar ini pendek dengan sengaja. Jawaban 404 pada leg pengalihan berarti
 * skripnya SUDAH berjalan dan yang gagal hanya pengambilan jawabannya, jadi
 * mengulang panggilan yang tidak idempoten akan menjalankannya dua kali.
 * apiCatatLog akan menulis dua baris log, apiIngatkan akan mengirim dua surel,
 * apiRapatBuat berisiko membuat dua undangan. Semuanya tidak masuk daftar. */
const AMAN_DIULANG = new Set([
  'apiKeadaan', 'apiIsiLembar', 'apiNotifBaru', 'apiSimpanBanyak', 'apiHapus',
  'apiUnggahMulai', 'apiUnggahPotong', 'apiFolderUmum', 'apiFolderAkun',
  'apiFolderProyek', 'apiSetelan', 'apiSimpanAturan', 'apiSimpanOtomasi',
  'apiStatusAkun', 'apiKalendarImpor'
]);

/* Panggilan yang boleh dilayani tanpa sesi. Selain dua ini, semuanya ditolak. */
const TANPA_SESI = new Set(['apiMasuk', 'diag', 'ping']);

/* ── kuki sesi bertanda tangan ──
 * Isinya dapat dibaca pemiliknya, tetapi tidak dapat diubah tanpa merusak
 * tanda tangannya, jadi tidak ada yang bisa mengaku sebagai orang lain. */

function tandaTangani(isi, rahasia) {
  const badan = Buffer.from(JSON.stringify(isi)).toString('base64url');
  const mac = crypto.createHmac('sha256', rahasia).update(badan).digest('base64url');
  return badan + '.' + mac;
}

function bukaTandaTangan(kuki, rahasia, sesiJam) {
  if (!kuki || !rahasia) return null;
  const [badan, mac] = String(kuki).split('.');
  if (!badan || !mac) return null;
  const harusnya = crypto.createHmac('sha256', rahasia).update(badan).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(harusnya);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const u = JSON.parse(Buffer.from(badan, 'base64url').toString());
    if (!u || !u.t) return null;
    if ((Date.now() / 1000 - Number(u.ts || 0)) > sesiJam * 3600) return null;
    return u;
  } catch (e) { return null; }
}

function bacaKuki(kepala, nama) {
  for (const bagian of String(kepala || '').split(';')) {
    const [k, ...v] = bagian.trim().split('=');
    if (k === nama) return decodeURIComponent(v.join('='));
  }
  return null;
}

function kepalaKuki(nama, nilai, umurDetik, aman, httpOnly) {
  return nama + '=' + encodeURIComponent(nilai) +
    '; Path=/; SameSite=Lax' + (httpOnly ? '; HttpOnly' : '') +
    (aman ? '; Secure' : '') + '; Max-Age=' + umurDetik;
}

/* ── ingatan pendek di dalam satu salinan yang sedang berjalan ──
 * Simpanan apiKeadaan DIKUNCI PER PENGGUNA. Apps Script SIMS menyaring
 * datanya per peran dan per baris, jadi simpanan bersama seperti di Research
 * Hub akan membocorkan data satu akun ke akun lain. Kuncinya sidik token,
 * bukan token itu sendiri. */
const ingatan = { keadaan: new Map(), gagal: new Map() };
const BATAS_INGATAN = 40;

function sidik(t) {
  return crypto.createHash('sha256').update(String(t)).digest('base64url').slice(0, 22);
}

function jumlahGagal(surel, kunciMenit) {
  const sejak = Date.now() - kunciMenit * 60000;
  const daftar = (ingatan.gagal.get(surel) || []).filter(t => t >= sejak);
  ingatan.gagal.set(surel, daftar);
  return daftar.length;
}

function catatGagal(surel) {
  const daftar = ingatan.gagal.get(surel) || [];
  daftar.push(Date.now());
  ingatan.gagal.set(surel, daftar);
}

/* ── memanggil Apps Script ──
 * Aplikasi web menjawab dengan pengalihan ke script.googleusercontent.com,
 * sama seperti terhadap peramban, jadi pengalihan wajib diikuti. */

class GalatSesaat extends Error {}

async function panggilGasSekali(muatan, batasMs, K) {
  const abort = new AbortController();
  const jam = setTimeout(() => abort.abort(), batasMs);
  let res;
  try {
    res = await fetch(K.gasUrl, {
      method: 'POST',
      redirect: 'follow',
      signal: abort.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(muatan)
    });
  } catch (e) {
    throw new GalatSesaat(e && e.name === 'AbortError'
      ? 'Apps Script tidak menjawab dalam ' + Math.round(batasMs / 1000) + ' detik.'
      : 'Apps Script tidak dapat dihubungi.');
  } finally { clearTimeout(jam); }

  const teks = await res.text();

  /* 404 di sini hampir selalu datang dari leg pengalihan ke
     script.googleusercontent.com, bukan dari alamat /exec yang salah. Kalau
     alamatnya benar-benar salah, panggilan pertama pun sudah gagal dan
     pengulangan tidak akan mengubah apa pun. */
  if (res.status === 404 || res.status === 429 || res.status >= 500) {
    throw new GalatSesaat('Apps Script menjawab kode ' + res.status + '.');
  }
  if (!res.ok) {
    throw new Error('Apps Script menjawab kode ' + res.status + '.');
  }

  try { return JSON.parse(teks); }
  catch (e) {
    if (/accounts\.google\.com|Sign in|Masuk ke akun/i.test(teks))
      throw new Error('Apps Script meminta masuk ke akun Google, bukan menjawab data. ' +
        'Ubah penyebaran jadi Execute as "Me" dan Who has access "Anyone".');
    if (/script error|Exception|TypeError|ReferenceError/i.test(teks))
      throw new Error('Apps Script melempar galat sebelum menjawab. Buka Executions di ' +
        'editor Apps Script untuk melihat baris yang jatuh.');
    throw new Error('Jawaban Apps Script bukan JSON (HTTP ' + res.status + '). ' +
      'Periksa akses penyebaran dan alamat /exec.');
  }
}

async function panggilGas(fn, args, batasMs, K) {
  if (!K.gasUrl || !/^https:\/\/script\.google\.com\/macros\//.test(K.gasUrl)) {
    throw new Error('Alamat aplikasi web Apps Script belum diisi. Isi SIMS_GAS_URL di Vercel.');
  }
  const muatan = { fn: fn, args: args || [] };
  const maks = AMAN_DIULANG.has(fn) ? Math.max(0, K.ulang) : 0;
  let terakhir = null;
  for (let coba = 0; coba <= maks; coba++) {
    try {
      return await panggilGasSekali(muatan, batasMs, K);
    } catch (e) {
      terakhir = e;
      if (!(e instanceof GalatSesaat) || coba === maks) break;
      await new Promise(r => setTimeout(r, 400 * (coba + 1)));
    }
  }
  throw terakhir;
}

/* ── satu permintaan ──────────────────────────────────────────────────────── */

/**
 * @param {object} req
 * @param {string} req.method
 * @param {object} [req.query]
 * @param {object} [req.body]
 * @param {string} [req.cookie]
 * @param {boolean} [req.secure]
 * @returns {Promise<{status:number, headers:object, body:string}>}
 */
export async function handleRequest(req) {
  const K = config();
  const kepala = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  const aman = K.kukiAman === 'auto' ? req.secure !== false : K.kukiAman !== 'false';
  const jawab = (obj, tambahan) => ({
    status: 200,
    headers: Object.assign({}, kepala, tambahan || {}),
    body: JSON.stringify(obj)
  });

  if (req.method === 'OPTIONS') return { status: 204, headers: kepala, body: '' };

  try {
    if (!K.rahasia) {
      return jawab({ ok: false, pesan:
        'SIMS_SESSION_SECRET belum diisi. Tanpa itu kuki sesi tidak dapat ' +
        'ditandatangani dan tidak ada yang bisa masuk.' });
    }

    const masuk = Object.assign({}, req.query || {}, req.body || {});
    const fn = String(masuk.fn || '').trim();
    let args = masuk.args;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = []; } }
    if (!Array.isArray(args)) args = [];
    if (!fn) return jawab({ ok: false, pesan: 'Panggilan tanpa nama fungsi.' });

    /* ── pemeriksaan mandiri ──
       Menjawab satu pertanyaan saja: apakah fungsi ini bisa menghubungi Apps
       Script, dan kalau tidak, kenapa. Ia tidak pernah menyebut id penyebaran
       maupun rahasia sesi, hanya ada atau tidaknya, jadi aman dibiarkan. */
    if (fn === 'diag') {
      const mentah = process.env.SIMS_GAS_URL || '';
      const info = {
        ok: true, node: process.version,
        rahasiaTerisi: !!K.rahasia,
        alamatTerisi: !!mentah,
        panjangAlamat: mentah.length,
        adaSpasi: /\s/.test(mentah),
        adaKutip: /["']/.test(mentah)
      };
      try {
        const u = new URL(K.gasUrl);
        info.terbaca = true;
        info.inang = u.host;
        info.berakhirExec = u.pathname.endsWith('/exec');
      } catch (e) { info.terbaca = false; info.galatBaca = String(e && e.message || e); }
      if (info.terbaca) {
        const t0 = Date.now();
        try {
          const r = await fetch(K.gasUrl, {
            method: 'POST', redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ fn: 'apiMasuk', args: ['uji-sambungan@contoh.invalid', 'x'] })
          });
          const teks = await r.text();
          info.kode = r.status;
          info.milidetik = Date.now() - t0;
          info.jawabanJson = teks.trim().startsWith('{');
          info.cuplikan = teks.trim().slice(0, 120);
        } catch (e) {
          info.milidetik = Date.now() - t0;
          info.galatAmbil = String(e && e.name || '') + ': ' + String(e && e.message || e);
        }
      }
      return jawab(info);
    }

    if (fn === 'ping') return jawab({ ok: true, data: { ok: true } });

    const sesi = bukaTandaTangan(bacaKuki(req.cookie, KUKI_SESI), K.rahasia, K.sesiJam) || bukaTandaTangan(String(masuk.stok || ''), K.rahasia, K.sesiJam);

    /* ── masuk ── */
    if (fn === 'apiMasuk') {
      const surel = String(args[0] || '').trim().toLowerCase();
      const sandi = String(args[1] || '');
      if (!surel || !sandi) return jawab({ ok: false, pesan: 'Surel dan kata sandi wajib diisi.' });
      if (jumlahGagal(surel, K.kunciMenit) >= K.maksGagal) {
        return jawab({ ok: false, pesan:
          'Terlalu banyak percobaan. Coba lagi setelah ' + K.kunciMenit + ' menit.' });
      }
      const hasil = await panggilGas('apiMasuk', [surel, sandi], K.batasMs, K);
      if (!hasil || !hasil.ok) {
        catatGagal(surel);
        return jawab({ ok: false, pesan: String((hasil && hasil.pesan) || 'Surel atau kata sandi tidak cocok.') });
      }
      ingatan.gagal.delete(surel);

      const data = hasil.data || {};
      const token = data.token;
      if (!token) {
        return jawab({ ok: false, pesan:
          'Apps Script menerima sandi tetapi tidak mengembalikan token sesi. Periksa apiMasuk di Code.gs.' });
      }
      /* Token milik peladen, bukan peramban. Ia dicabut dari jawaban lalu
         dititipkan ke kuki yang tidak dapat dibaca JavaScript. */
      const bersih = Object.assign({}, data);
      delete bersih.token;

      const umur = K.sesiJam * 3600;
      const nilaiSesi = tandaTangani({ t: token, m: surel, ts: Math.floor(Date.now() / 1000) }, K.rahasia);
      const kukiSesi = kepalaKuki(KUKI_SESI, nilaiSesi, umur, aman, true);
      const kukiAda = kepalaKuki(KUKI_ADA, '1', umur, aman, false);

      bersih.stok = nilaiSesi;
      return jawab({ ok: true, data: bersih }, { 'Set-Cookie': [kukiSesi, kukiAda] });
    }

    /* ── keluar ── */
    if (fn === 'apiKeluar') {
      const kosongSesi = kepalaKuki(KUKI_SESI, '', 0, aman, true);
      const kosongAda = kepalaKuki(KUKI_ADA, '', 0, aman, false);
      if (sesi) {
        ingatan.keadaan.delete(sidik(sesi.t));
        try { await panggilGas('apiKeluar', [sesi.t], K.batasMs, K); } catch (e) {}
      }
      return jawab({ ok: true, data: { ok: true } }, { 'Set-Cookie': [kosongSesi, kosongAda] });
    }

    /* ── gerbang ──
       Penulisan ditolak terang-terangan, bukan dijawab seolah berhasil.
       Antarmuka menahan perubahan di perangkat lalu mencoba lagi, jadi tidak
       ada suntingan yang hilang saat sesi berakhir. */
    if (!sesi && !TANPA_SESI.has(fn)) {
      return jawab({ ok: false, pesan: SESI_HABIS },
        { 'Set-Cookie': [kepalaKuki(KUKI_ADA, '', 0, aman, false)] });
    }

    /* ── penerusan ──
       Token disisipkan di sini sebagai argumen pertama, persis di posisi yang
       dulu diisi jembatan peramban. Apa pun yang dikirim peramban di posisi
       itu dibuang lebih dulu. */
    const kunciCache = sidik(sesi.t);
    if (fn === 'apiKeadaan' && K.cacheDetik > 0) {
      const simpan = ingatan.keadaan.get(kunciCache);
      if (simpan && Date.now() < simpan.sampai) return jawab(simpan.isi);
    }

    const argsPeladen = [sesi.t].concat(args.slice(1));
    const batas = /^apiUnggah/.test(fn) ? K.unggahMs : K.batasMs;
    const hasil = await panggilGas(fn, argsPeladen, batas, K);

    if (hasil && hasil.ok && fn === 'apiKeadaan' && K.cacheDetik > 0) {
      if (ingatan.keadaan.size > BATAS_INGATAN) ingatan.keadaan.clear();
      ingatan.keadaan.set(kunciCache, { isi: hasil, sampai: Date.now() + K.cacheDetik * 1000 });
    }
    /* Sekali ada tulisan, salinan keadaan pengguna ini basi. */
    if (fn !== 'apiKeadaan') ingatan.keadaan.delete(kunciCache);

    /* Apps Script menolak token yang sudah mati. Kukinya ikut dibersihkan
       supaya antarmuka langsung kembali ke layar masuk, bukan berputar-putar
       mencoba panggilan yang pasti ditolak. */
    /* Dicocokkan ke dua kalimat yang benar-benar dipakai ambilSesi di Code.gs,
       bukan ke kata "sesi" di mana pun. Code.gs juga melempar "Sesi unggahan
       tidak ditemukan", "Sesi unggahan itu bukan milik Anda", dan "Sesi
       unggahan kedaluwarsa"; pencocokan yang longgar akan membaca ketiganya
       sebagai sesi mati lalu mengeluarkan pengguna di tengah unggahan. */
    if (hasil && !hasil.ok && /^Sesi (?!unggahan\b)/i.test(String(hasil.pesan || ''))) {
      return jawab({ ok: false, pesan: SESI_HABIS }, {
        'Set-Cookie': [kepalaKuki(KUKI_SESI, '', 0, aman, true),
                       kepalaKuki(KUKI_ADA, '', 0, aman, false)]
      });
    }

    return jawab(hasil);

  } catch (e) {
    console.error('[sims] ' + (e && e.message ? e.message : e));
    return jawab({ ok: false, pesan: String(e && e.message ? e.message : e) });
  }
}

/* ── penyambung ke Node ───────────────────────────────────────────────────── */

export async function bacaBadanJson(aliran) {
  if (aliran && aliran.body && typeof aliran.body === 'object' && !Buffer.isBuffer(aliran.body)) {
    return aliran.body;
  }
  const potongan = [];
  for await (const c of aliran) potongan.push(c);
  const teks = Buffer.concat(potongan).toString('utf8');
  if (!teks) return {};
  try { return JSON.parse(teks); } catch (e) { return {}; }
}

export async function nodeHandler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const query = Object.fromEntries(url.searchParams.entries());
  const body = req.method === 'POST' ? await bacaBadanJson(req) : {};
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const out = await handleRequest({
    method: req.method,
    query,
    body,
    cookie: req.headers.cookie || '',
    secure: proto ? proto === 'https' : (req.socket && req.socket.encrypted === true)
  });
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.statusCode = out.status;
  res.end(out.body);
}

/* Titik masuk yang dipanggil Vercel. */
export default async function handler(req, res) {
  try {
    await nodeHandler(req, res);
  } catch (e) {
    console.error('[sims] ' + (e && e.message ? e.message : e));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, pesan: 'Galat di dalam perantara.' }));
  }
}
