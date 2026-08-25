/* ===== Aplikasi Keuangan - Roudhotul Qur'an ===== */
/* Penyimpanan: SUPABASE SEBAGAI SUMBER UTAMA.
   - Setiap perubahan data (setoran/tarik, tagihan, iuran, dll) dikirim LANGSUNG ke Supabase
     saat itu juga selama online — itulah data yang dianggap benar/final.
   - IndexedDB di perangkat cuma CADANGAN: (1) menyimpan salinan data terakhir supaya
     aplikasi tetap bisa dibuka & dipakai saat internet/listrik mati, dan (2) menampung
     sementara transaksi yang gagal terkirim (offline atau error jaringan) dalam antrean
     (DB.syncQueue), untuk otomatis dikirim ulang ke Supabase begitu online lagi.
   - Saat aplikasi dibuka dan online, data terbaru ditarik dulu dari Supabase sebelum
     ditampilkan (bukan langsung pakai cache lama), supaya selalu sinkron dengan perangkat
     lain. Kalau offline, baru dipakai salinan IndexedDB yang terakhir tersimpan.
   Semua state aplikasi tetap disimpan sinkron di memori (variabel DB) untuk kompatibilitas
   kode lama; saveDB() menulis salinan cadangan ke IndexedDB setiap kali DB berubah. */

const OLD_LS_KEY = 'keuangan_db_v1';   // key localStorage versi lama, dipakai sekali untuk migrasi
const IDB_NAME = 'keuangan_pwa';
const IDB_STORE = 'kv';
const IDB_KEY = 'db';

/* Mengubah karakter khusus HTML (<, >, &, ", ') jadi bentuk aman sebelum
   ditampilkan, supaya teks bebas-ketik dari pengguna lain (mis. nama santri
   yang diisi admin_pusat) tidak bisa dieksekusi sebagai kode HTML/JS saat
   dirender lewat innerHTML di app ini. */
function escapeHtml(str){
  if(str===null || str===undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function idbOpen(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = ()=>{ req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}
function idbGet(key){
  return idbOpen().then(db=>new Promise((resolve, reject)=>{
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  }));
}
function idbSet(key, value){
  return idbOpen().then(db=>new Promise((resolve, reject)=>{
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  }));
}

/* ===== SUPABASE: klien & sinkron ===== */
let sb = null;
try{
  if(window.supabase && typeof SUPABASE_URL==='string' && SUPABASE_URL.indexOf('ISI-PROJECT-REF')===-1){
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
}catch(err){ console.error('Supabase belum dikonfigurasi', err); }

/* ===== LOGIN (Supabase Auth) =====
   RLS di database mengharuskan setiap yang menulis data (buat tagihan, dll) sudah
   login sebagai user dengan role bendahara/admin_pusat/kasir (lihat tabel profil_akun).
   Tanpa login, permintaan SELECT biasanya kembali kosong (diam-diam, tanpa error),
   sedangkan permintaan INSERT/UPDATE akan DITOLAK oleh RLS dan otomatis masuk ke
   antrean cadangan (syncQueue) berulang kali tanpa pernah berhasil. */
async function doLogin(){
  const email = val('loginEmail').trim();
  const password = val('loginPassword');
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');
  errEl.style.display = 'none';
  if(!sb){ errEl.textContent = 'Supabase belum dikonfigurasi (config.js)'; errEl.style.display='block'; return; }
  if(!email || !password){ errEl.textContent = 'Isi email dan kata sandi.'; errEl.style.display='block'; return; }
  btn.disabled = true; btn.textContent = 'Memproses...';
  try{
    const {error} = await sb.auth.signInWithPassword({email, password});
    if(error) throw error;
    // onAuthStateChange akan menangani perpindahan ke layar aplikasi
  }catch(err){
    console.error('Gagal login', err);
    errEl.textContent = 'Email atau kata sandi salah, atau belum terdaftar.';
    errEl.style.display = 'block';
  }
  btn.disabled = false; btn.textContent = 'Masuk';
}
async function doLogout(){
  if(!confirm('Keluar dari aplikasi?')) return;
  if(sb) await sb.auth.signOut();
  // onAuthStateChange akan menangani perpindahan kembali ke layar login
}
function showLoginScreen(){
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}
function showAppScreen(){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = '';
}
let appBooted = false;
/* Dipanggil sekali user sudah dipastikan login, untuk memuat data & menampilkan aplikasi. */
async function bootApp(){
  showAppScreen();
  if(appBooted) return; // sudah pernah boot sebelumnya (mis. login ulang tanpa reload), jangan ulang render awal
  appBooted = true;
  renderNav();
  document.getElementById('content').innerHTML = '<p class="muted" style="padding:20px 4px">Memuat data&hellip;</p>';
  await initDB();
  generateTagihanBerulang();
  if(sb && navigator.onLine){
    document.getElementById('content').innerHTML = '<p class="muted" style="padding:20px 4px">Mengambil data terbaru dari Supabase&hellip;</p>';
    try{ await pullAll(); }
    catch(err){ console.error('Gagal mengambil data dari Supabase, memakai cadangan lokal', err); }
  }
  goPage('beranda');
  updateSyncBadge();
  trySync(); // kirim antrean cadangan (kalau ada) yang belum sempat terkirim
}

/* Setiap perubahan data dicoba kirim LANGSUNG ke Supabase dulu (sumber utama).
   Kalau berhasil, selesai (tidak masuk antrean). Kalau gagal/offline, baru disimpan
   ke antrean DB.syncQueue (dukungan IndexedDB) untuk dikirim ulang otomatis nanti. */
async function queueSync(table, op, payload){
  DB.syncQueue = DB.syncQueue || [];
  if(sb && navigator.onLine){
    try{
      if(op==='upsert'){
        const {error} = await sb.from(table).upsert(payload);
        if(error) throw error;
      } else if(op==='delete'){
        const {error} = await sb.from(table).delete().eq('id', payload.id);
        if(error) throw error;
      }
      updateSyncBadge();
      return; // berhasil langsung ke Supabase, tidak perlu antrean cadangan
    }catch(err){
      console.error('Gagal kirim langsung ke Supabase, disimpan sebagai cadangan offline:', table, err);
    }
  }
  // Offline atau pengiriman gagal -> simpan ke antrean cadangan (IndexedDB) untuk dicoba lagi nanti
  DB.syncQueue.push({id:'sq'+Date.now()+Math.random(), table, op, payload, ts:Date.now()});
  saveDB(DB);
  updateSyncBadge();
}
let syncing = false;
let lastSyncAt = null;
/* Cadangan: coba kirim ulang antrean yang gagal/tertunda ke Supabase (dipanggil berkala &
   saat online kembali). Kalau antrean sudah kosong, sekalian tarik data terbaru dari Supabase. */
async function trySync(){
  updateSyncBadge();
  if(!sb || syncing || !navigator.onLine) return;
  if(!(DB.syncQueue||[]).length){ await pullAll(); lastSyncAt = Date.now(); updateSyncBadge(); return; }
  syncing = true;
  updateSyncBadge();
  const queue = DB.syncQueue.slice();
  for(const item of queue){
    try{
      if(item.op==='upsert'){
        const {error} = await sb.from(item.table).upsert(item.payload);
        if(error) throw error;
      } else if(item.op==='delete'){
        const {error} = await sb.from(item.table).delete().eq('id', item.payload.id);
        if(error) throw error;
      }
      DB.syncQueue = DB.syncQueue.filter(q=>q.id!==item.id);
      saveDB(DB);
    }catch(err){
      console.error('Sinkron gagal untuk', item.table, err);
      break; // hentikan, coba lagi nanti; urutan antrean tetap terjaga
    }
  }
  syncing = false;
  if(!(DB.syncQueue||[]).length) await pullAll();
  lastSyncAt = Date.now();
  updateSyncBadge();
}
function updateSyncBadge(){
  const el = document.getElementById('syncBadge');
  if(!el) return;
  if(!sb){ el.textContent = 'Supabase belum dikonfigurasi (config.js)'; return; }
  const pending = (DB.syncQueue||[]).length;
  if(!navigator.onLine){ el.textContent = 'Offline - pakai cadangan lokal' + (pending?(' - '+pending+' menunggu dikirim'):''); return; }
  if(syncing){ el.textContent = 'Mengirim ke Supabase...'; return; }
  if(pending){ el.textContent = pending+' data cadangan belum terkirim ke Supabase'; return; }
  el.textContent = 'Tersambung ke Supabase';
}

/* Tarik data terbaru dari Supabase (SUMBER UTAMA) dan gabungkan ke IndexedDB (cadangan lokal).
   Dijalankan saat aplikasi dibuka (kalau online) dan tiap kali antrean cadangan sudah kosong,
   supaya data selalu mengikuti Supabase, bukan cache lama di perangkat. */
async function pullAll(){
  if(!sb || !navigator.onLine) return;
  try{ await pullSantri(); }catch(err){ console.error('Gagal menarik santri', err); }
  try{ await pullTable('jenis_tagihan', 'jenisTagihan', rowToJenisTagihan); }catch(err){ console.error('Gagal menarik jenis tagihan', err); }
  try{ await pullTable('transaksi_saldo', 'transaksiSaldo', rowToTransaksiSaldo); }catch(err){ console.error('Gagal menarik transaksi saldo', err); }
  try{ await pullTable('tagihan', 'tagihan', rowToTagihan); }catch(err){ console.error('Gagal menarik tagihan', err); }
  try{ await pullTable('tagihan_berulang', 'tagihanBerulang', rowToBerulang); }catch(err){ console.error('Gagal menarik tagihan berulang', err); }
  try{ await pullTable('transaksi_toko', 'transaksiToko', rowToTransaksiToko); }catch(err){ console.error('Gagal menarik transaksi toko', err); }
  try{ await pullIuran(); }catch(err){ console.error('Gagal menarik iuran', err); }
  recomputeSaldoSemua();
  saveDB(DB);
  if(['beranda','saldo','tagihan','iuran','riwayat','santri','kelola'].includes(currentPage)) goPage(currentPage);
}
async function pullSantri(){
  const {data, error} = await sb.from('santri_umum').select('id, nama, no_induk, jenis_kelamin, kelas, program').eq('aktif', true);
  if(error) throw error;
  (data||[]).forEach(row=>{
    let s = DB.santri.find(x=>x.id===row.id);
    if(!s){
      s = {id:row.id, nama:row.nama, noInduk:row.no_induk, jenisKelamin:row.jenis_kelamin||'', kelas:row.kelas||'', program:row.program||'', saldo:0};
      DB.santri.push(s);
    } else {
      s.nama = row.nama; s.noInduk = row.no_induk; s.jenisKelamin = row.jenis_kelamin||''; s.kelas = row.kelas||''; s.program = row.program||'';
    }
  });
  const idsAktif = new Set((data||[]).map(r=>r.id));
  DB.santri = DB.santri.filter(s=>idsAktif.has(s.id));
}
function rowToJenisTagihan(row){ return {id:row.id, nama:row.nama}; }
function rowToTransaksiSaldo(row){ return {id:row.id, santriId:row.santri_id, jenis:row.jenis, jumlah:Number(row.jumlah), keterangan:row.keterangan, tanggal:row.tanggal}; }
function rowToTagihan(row){ return {id:row.id, santriId:row.santri_id, jenisId:row.jenis_tagihan_id, bulan:row.bulan, jumlah:Number(row.jumlah), status:row.status, tglBayar:row.tgl_bayar, caraBayar:row.cara_bayar, jatuhTempo:row.jatuh_tempo, berulangId:row.berulang_id||undefined}; }
function rowToBerulang(row){ return {id:row.id, jenisId:row.jenis_tagihan_id, jumlah:Number(row.jumlah), target:row.target, targetManualIds:row.target_manual_ids||[], tempoHari:row.tempo_hari, mulaiBulan:row.mulai_bulan, aktif:row.aktif}; }
function rowToTransaksiToko(row){ return {id:row.id, santriId:row.santri_id, total:Number(row.total)||0, tanggal:(row.created_at||'').slice(0,10), catatan:row.catatan||''}; }
async function pullTable(table, dbKey, mapRow){
  const {data, error} = await sb.from(table).select('*');
  if(error) throw error;
  (data||[]).forEach(row=>{
    const item = mapRow(row);
    const idx = DB[dbKey].findIndex(x=>x.id===item.id);
    if(idx===-1) DB[dbKey].push(item); else DB[dbKey][idx] = item;
  });
}
async function pullIuran(){
  const {data: iuranRows, error: e1} = await sb.from('iuran').select('*');
  if(e1) throw e1;
  const {data: detailRows, error: e2} = await sb.from('iuran_detail').select('*');
  if(e2) throw e2;
  (iuranRows||[]).forEach(row=>{
    const items = (detailRows||[]).filter(d=>d.iuran_id===row.id).map(d=>({id:d.id, santriId:d.santri_id, jumlah:Number(d.jumlah), status:d.status, caraBayar:d.cara_bayar, tglBayar:d.tgl_bayar}));
    const idx = DB.iuran.findIndex(x=>x.id===row.id);
    const item = {id:row.id, tanggal:row.tanggal, keterangan:row.keterangan, items};
    if(idx===-1) DB.iuran.push(item); else DB.iuran[idx] = item;
  });
}
/* Saldo santri selalu dihitung ulang dari riwayat transaksiSaldo (ledger), bukan disimpan
   sebagai angka lepas — supaya konsisten walau data digabung dari beberapa perangkat/Supabase. */
function recomputeSaldoSemua(){
  const totals = {};
  DB.transaksiSaldo.forEach(t=>{
    totals[t.santriId] = (totals[t.santriId]||0) + (t.jenis==='setoran'? t.jumlah : -t.jumlah);
  });
  DB.santri.forEach(s=>{ s.saldo = totals[s.id]||0; });
}
window.addEventListener('online', trySync);
window.addEventListener('offline', updateSyncBadge);
setInterval(trySync, 20000);

function defaultDB(){
  return {
    santri: [],           // {id, nama, noInduk, jenisKelamin:'L'|'P', kelas:'7'..'12'|'Lulus', program:'Takhossus'|'Non-Takhossus', saldo} - ditarik read-only dari Aplikasi Pondok
    jenisTagihan: [
      {id:'t1', nama:'SPP Bulanan'}
    ],
    transaksiSaldo: [],   // {id, santriId, jenis:'setoran'|'tarik'|'bayar', jumlah, keterangan, tanggal}
    tagihan: [],          // {id, santriId, jenisId, bulan(YYYY-MM), jumlah, status:'belum'|'lunas', tglBayar, caraBayar:'tunai'|'saldo', jatuhTempo, berulangId?}
    iuran: [],             // {id, tanggal, keterangan, items:[{id,santriId,jumlah,status:'belum'|'lunas',caraBayar,tglBayar}]}
    tagihanBerulang: [],   // {id, jenisId, jumlah, target, targetManualIds, tempoHari, mulaiBulan, aktif}
    transaksiToko: [],     // {id, santriId, total, tanggal, catatan} - ditarik read-only dari tabel transaksi_toko (Aplikasi Kasir Toko)
    syncQueue: []          // {id, table, op:'upsert'|'delete', payload} - antrean kirim ke Supabase
  };
}
function normalizeDB(db){
  if(!db.santri) db.santri = [];
  if(!db.jenisTagihan) db.jenisTagihan = [{id:'t1', nama:'SPP Bulanan'}];
  if(!db.transaksiSaldo) db.transaksiSaldo = [];
  if(!db.tagihan) db.tagihan = [];
  if(!db.iuran) db.iuran = [];
  if(!db.tagihanBerulang) db.tagihanBerulang = [];
  if(!db.transaksiToko) db.transaksiToko = [];
  if(!db.syncQueue) db.syncQueue = [];
  migrateIuran(db);
  return db;
}
function migrateIuran(db){
  // Kompatibilitas data lama: sebelumnya iuran langsung potong saldo tanpa status per-item
  // dan tanpa tercatat di riwayat saldo. Migrasi ini menandai lunas(saldo) + membuat catatan riwayatnya.
  let changed = false;
  (db.iuran||[]).forEach(it=>{
    (it.items||[]).forEach(i=>{
      if(!i.id){ i.id = 'iui'+Date.now()+Math.random(); changed = true; }
      if(i.status===undefined){
        i.status='lunas'; i.caraBayar='saldo'; i.tglBayar = i.tglBayar || it.tanggal;
        db.transaksiSaldo = db.transaksiSaldo || [];
        const trx = {id:'tr'+Date.now()+Math.random(), santriId: i.santriId, jenis:'bayar', jumlah: i.jumlah, keterangan:'Bayar iuran - '+it.keterangan, tanggal: i.tglBayar};
        db.transaksiSaldo.push(trx);
        // migrasi data lama: antre langsung ke db.syncQueue milik objek ini (belum tentu jadi DB global saat fungsi ini jalan)
        db.syncQueue = db.syncQueue || [];
        db.syncQueue.push({id:'sq'+Date.now()+Math.random(), table:'transaksi_saldo', op:'upsert', payload:{id:trx.id, santri_id:trx.santriId, jenis:trx.jenis, jumlah:trx.jumlah, keterangan:trx.keterangan, tanggal:trx.tanggal}, ts:Date.now()});
        changed = true;
      }
    });
  });
  if(changed) saveDB(db);
}
function saveDB(db){
  DB = db;
  idbSet(IDB_KEY, db).catch(err=>{ console.error('Gagal menyimpan ke IndexedDB', err); });
}
let DB = defaultDB();
let dbReady = false;

async function initDB(){
  let data = null;
  try{ data = await idbGet(IDB_KEY); }catch(err){ console.error('IndexedDB tidak tersedia', err); }
  if(!data){
    // migrasi sekali dari localStorage versi lama (jika ada), lalu bersihkan
    try{
      const old = JSON.parse(localStorage.getItem(OLD_LS_KEY) || 'null');
      if(old){ data = old; localStorage.removeItem(OLD_LS_KEY); }
    }catch(err){}
  }
  DB = normalizeDB(data || defaultDB());
  saveDB(DB);
  dbReady = true;
}

const NAV = [
  {id:'beranda', label:'Beranda', icon:'&#8962;'},
  {id:'scan', label:'Scan QR', icon:'&#128247;'},
  {id:'saldo', label:'Saldo', icon:'&#128176;'},
  {id:'tagihan', label:'Tagihan', icon:'&#128179;'},
  {id:'iuran', label:'Iuran', icon:'&#129309;'},
  {id:'riwayat', label:'Riwayat', icon:'&#128203;'},
  {id:'santri', label:'Santri', icon:'&#128101;'},
  {id:'kelola', label:'Kelola', icon:'&#9881;'}
];
let currentPage='beranda';

function renderNav(){
  let html = NAV.map(i=>`<button class="navitem" data-p="${i.id}" onclick="goPage('${i.id}')"><span class="ic">${i.icon}</span><span>${i.label}</span></button>`).join('');
  html += `<button class="navitem navitem-logout" onclick="doLogout()"><span class="ic">&#9211;</span><span>Log Out</span></button>`;
  document.getElementById('bottomnav').innerHTML = html;
  document.getElementById('sidebar').innerHTML = html;
}
function goPage(p){
  if(currentPage==='scan' && p!=='scan') stopScan(false);
  currentPage=p;
  document.querySelectorAll('.navitem').forEach(el=>el.classList.toggle('active', el.dataset.p===p));
  if(p==='beranda') renderBeranda();
  if(p==='scan') renderScanPage();
  if(p==='saldo') renderSaldoPage();
  if(p==='tagihan') renderTagihanPage();
  if(p==='iuran') renderIuranPage();
  if(p==='riwayat') renderRiwayatPage();
  if(p==='santri') renderSantriPage();
  if(p==='kelola') renderKelolaPage();
}
function val(id){ return document.getElementById(id).value; }
function todayStr(){ return new Date().toISOString().slice(0,10); }
function bulanStr(d){ return (d||todayStr()).slice(0,7); }
function rupiah(n){ return 'Rp ' + (n||0).toLocaleString('id-ID'); }
function santriNama(id){ const s=DB.santri.find(x=>x.id===id); return s?s.nama:'(santri tidak ditemukan)'; }
function saldo(id){ const s=DB.santri.find(x=>x.id===id); return s?s.saldo||0:0; }

/* Input nominal: format otomatis titik ribuan sambil mengetik (mis. 1.500.000) */
function formatRibuan(str){
  const digits = String(str||'').replace(/[^\d]/g,'');
  if(!digits) return '';
  return parseInt(digits,10).toLocaleString('id-ID');
}
function onRupiahInput(el){
  el.value = formatRibuan(el.value);
  el.setSelectionRange(el.value.length, el.value.length);
}
function rupiahVal(id){
  const digits = val(id).replace(/[^\d]/g,'');
  return parseInt(digits,10)||0;
}
function rupiahInputHtml(id, placeholder){
  return `<input id="${id}" type="text" inputmode="numeric" placeholder="${placeholder||'0'}" oninput="onRupiahInput(this)">`;
}

/* ---------- BERANDA ---------- */
function daysLate(dateStr){
  const d1 = new Date(dateStr+'T00:00:00'), d2 = new Date(todayStr()+'T00:00:00');
  return Math.max(0, Math.round((d2-d1)/86400000));
}
function getOverdueBySantri(){
  const today = todayStr();
  const map = {};
  DB.tagihan.filter(t=>t.status==='belum' && t.jatuhTempo && t.jatuhTempo<today).forEach(t=>{
    if(!map[t.santriId]) map[t.santriId] = {santriId:t.santriId, count:0, total:0, oldest:t.jatuhTempo};
    const o = map[t.santriId];
    o.count++; o.total += t.jumlah;
    if(t.jatuhTempo < o.oldest) o.oldest = t.jatuhTempo;
  });
  return Object.values(map).sort((a,b)=>a.oldest.localeCompare(b.oldest));
}
function getPembayaranHariIni(){
  const today = todayStr();
  let tunai = 0, saldoTotal = 0;
  DB.tagihan.forEach(t=>{
    if(t.status==='lunas' && t.tglBayar===today){
      if(t.caraBayar==='tunai') tunai += t.jumlah;
      else if(t.caraBayar==='saldo') saldoTotal += t.jumlah;
    }
  });
  (DB.iuran||[]).forEach(it=>{
    (it.items||[]).forEach(i=>{
      if(i.status==='lunas' && i.tglBayar===today){
        if(i.caraBayar==='tunai') tunai += i.jumlah;
        else if(i.caraBayar==='saldo') saldoTotal += i.jumlah;
      }
    });
  });
  return {tunai, saldo:saldoTotal};
}
function renderBeranda(){
  generateTagihanBerulang();
  const today = todayStr();
  const setoranHariIni = DB.transaksiSaldo.filter(t=>t.tanggal===today && t.jenis==='setoran').reduce((a,b)=>a+b.jumlah,0);
  const belumBayarBln = DB.tagihan.filter(t=>t.bulan===bulanStr() && t.status==='belum').length;
  const overdue = getOverdueBySantri();
  const pembayaran = getPembayaranHariIni();
  document.getElementById('content').innerHTML = `
    <h2>Beranda</h2>
    <p class="muted">${DB.santri.length} santri terdaftar</p>
    <div class="grid2" style="margin-top:12px">
      <div class="stat"><div class="num">${rupiah(setoranHariIni)}</div><div class="label">Setoran hari ini</div></div>
      <div class="stat"><div class="num">${belumBayarBln}</div><div class="label">Belum bayar SPP bulan ini</div></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="card-title">Laporan pembayaran tagihan/iuran hari ini</div>
      <div class="grid2">
        <div class="stat"><div class="num">${rupiah(pembayaran.tunai)}</div><div class="label">Tunai (kas fisik)</div></div>
        <div class="stat"><div class="num">${rupiah(pembayaran.saldo)}</div><div class="label">Dari saldo santri</div></div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="card-title">Menu cepat</div>
      <div class="btn-row">
        <button class="btn btn-accent" onclick="goPage('scan')">Scan QR (Top Up/Tarik)</button>
        <button class="btn btn-accent" onclick="goPage('tagihan')">Kelola Tagihan</button>
        <button class="btn" onclick="goPage('iuran')">Iuran/Sosial</button>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="card-title">Melewati tenggat waktu pembayaran (${overdue.length} santri)</div>
      ${overdue.length===0?'<p class="muted">Tidak ada tagihan yang terlambat. &#127881;</p>':overdue.map(o=>`
        <div class="list-item">
          <div class="avatar">${escapeHtml((santriNama(o.santriId)||'?').slice(0,2).toUpperCase())}</div>
          <div style="flex:1">
            <div class="name">${escapeHtml(santriNama(o.santriId))}</div>
            <div class="sub">${o.count} tagihan &middot; jatuh tempo ${o.oldest} &middot; <span class="tag tag-late">Terlambat ${daysLate(o.oldest)} hari</span></div>
          </div>
          <div style="font-weight:700;color:#c0392b">${rupiah(o.total)}</div>
        </div>`).join('')}
    </div>
    ${DB.santri.length===0?`<div class="card"><p class="muted">Belum ada data santri. Sinkronkan dulu dari Aplikasi Pondok lewat tombol &#8635; di kanan atas.</p></div>`:''}
  `;
}

/* ---------- SALDO: Setoran & Tarik ---------- */
function renderSaldoPage(){
  document.getElementById('content').innerHTML = `
    <h2>Saldo Santri</h2>
    <div class="card">
      ${DB.santri.length===0?'<p class="muted">Belum ada data santri.</p>':DB.santri.map(s=>`
        <div class="list-item">
          <div class="avatar">${(s.nama||'?').slice(0,2).toUpperCase()}</div>
          <div style="flex:1"><div class="name">${escapeHtml(s.nama)}</div><div class="sub">No. induk ${s.noInduk}</div></div>
          <div style="text-align:right">
            <div style="font-weight:700">${rupiah(s.saldo)}</div>
            <div class="btn-row" style="margin-top:4px">
              <button class="btn btn-sm btn-accent" onclick="openSetoran('${s.id}')">Setor</button>
              <button class="btn btn-sm" onclick="openTarik('${s.id}')">Tarik</button>
            </div>
          </div>
        </div>`).join('')}
    </div>
  `;
}
function openSetoran(santriId){
  showModal('Setoran - '+escapeHtml(santriNama(santriId)), `
    <label>Jumlah</label>${rupiahInputHtml('sd_jumlah')}
    <label>Keterangan</label><input id="sd_ket" placeholder="Setoran dari wali">
    <label>Tanggal</label><input id="sd_tgl" type="date" value="${todayStr()}">
    <div class="btn-row"><button class="btn btn-accent" onclick="saveTransaksiSaldo('${santriId}','setoran')">Simpan</button></div>
  `);
}
function openTarik(santriId){
  showModal('Tarik Tunai - '+escapeHtml(santriNama(santriId)), `
    <p class="muted">Saldo saat ini: ${rupiah(saldo(santriId))}</p>
    <label>Jumlah</label>${rupiahInputHtml('sd_jumlah')}
    <label>Keterangan</label><input id="sd_ket" placeholder="Contoh: Tarik saldo akhir tahun">
    <label>Tanggal</label><input id="sd_tgl" type="date" value="${todayStr()}">
    <div class="btn-row"><button class="btn btn-accent" onclick="saveTransaksiSaldo('${santriId}','tarik')">Simpan</button></div>
  `);
}
function saveTransaksiSaldo(santriId, jenis){
  const jumlah = rupiahVal('sd_jumlah');
  if(jumlah<=0){ alert('Jumlah harus lebih dari 0'); return; }
  const s = DB.santri.find(x=>x.id===santriId);
  if(jenis==='tarik' && jumlah>(s.saldo||0)){ if(!confirm('Jumlah tarik melebihi saldo saat ini. Lanjutkan?')) return; }
  const trx = {id:'tr'+Date.now(), santriId, jenis, jumlah, keterangan: val('sd_ket'), tanggal: val('sd_tgl')};
  DB.transaksiSaldo.push(trx);
  s.saldo = (s.saldo||0) + (jenis==='setoran'? jumlah : -jumlah);
  saveDB(DB);
  queueSync('transaksi_saldo', 'upsert', {id:trx.id, santri_id:trx.santriId, jenis:trx.jenis, jumlah:trx.jumlah, keterangan:trx.keterangan, tanggal:trx.tanggal});
  closeModal();
  if(currentPage==='scan'){
    renderScanPage();
    document.getElementById('scanResultCard').innerHTML = `
      <div class="card">
        <p style="color:#2f7d4f;font-weight:600;margin:0 0 4px">&#10003; ${jenis==='setoran'?'Top up':'Tarik tunai'} ${escapeHtml(s.nama)} berhasil disimpan.</p>
        <p class="muted" style="margin:0">Saldo sekarang: ${rupiah(s.saldo)}</p>
        <div class="btn-row"><button class="btn btn-accent" onclick="startScan()">Scan santri berikutnya</button></div>
      </div>`;
  } else {
    renderSaldoPage();
  }
}

/* ---------- SCAN QR (Top Up & Tarik Tunai via kamera) ---------- */
let scanStream = null, scanRAF = null, scanMode = null, scanBusy = false, torchOn = false;

function findSantriByCode(text){
  text = (text||'').trim();
  if(!text) return null;
  let s = DB.santri.find(x=>x.id===text);
  if(s) return s;
  s = DB.santri.find(x=>String(x.noInduk||'').trim()===text);
  if(s) return s;
  try{
    const obj = JSON.parse(text);
    if(obj && obj.id){ s = DB.santri.find(x=>x.id===obj.id); if(s) return s; }
    if(obj && obj.noInduk){ s = DB.santri.find(x=>String(x.noInduk||'').trim()===String(obj.noInduk).trim()); if(s) return s; }
  }catch(e){}
  try{
    const url = new URL(text);
    const qid = url.searchParams.get('id') || url.searchParams.get('noInduk') || url.searchParams.get('santri');
    if(qid){ s = DB.santri.find(x=>x.id===qid || String(x.noInduk||'').trim()===qid); if(s) return s; }
  }catch(e){}
  return null;
}

function renderScanPage(){
  const supported = 'BarcodeDetector' in window;
  document.getElementById('content').innerHTML = `
    <h2>Scan QR Santri</h2>
    <p class="muted">Pilih jenis transaksi, lalu arahkan kamera ke kartu QR santri. Cocok dipakai saat santri antre top up / tarik tunai.</p>
    <div class="card">
      <div class="card-title">Jenis transaksi</div>
      <div class="btn-row">
        <button class="btn ${scanMode==='setoran'?'btn-accent':''}" onclick="setScanMode('setoran')">Top Up (Setor)</button>
        <button class="btn ${scanMode==='tarik'?'btn-accent':''}" onclick="setScanMode('tarik')">Tarik Tunai</button>
      </div>
    </div>
    <div class="card">
      ${!supported?`<p class="muted">Browser di HP ini belum mendukung pemindai QR bawaan. Gunakan Chrome versi terbaru di Android, atau pakai input manual di bawah.</p>`:`
      <div id="scanArea" style="display:none">
        <video id="scanVideo" class="scan-video" playsinline autoplay muted></video>
        <div class="btn-row">
          <button class="btn" id="torchBtn" onclick="toggleTorch()" style="display:none">&#128294; Nyalakan Senter</button>
          <button class="btn" onclick="stopScan()">Hentikan kamera</button>
        </div>
      </div>
      <div class="btn-row" id="scanStartRow">
        <button class="btn btn-accent" onclick="startScan()">&#128247; ${scanMode?'Mulai Scan':'Pilih jenis transaksi dulu'}</button>
      </div>`}
      <label style="margin-top:14px">Atau masukkan kode manual (jika kamera/QR bermasalah)</label>
      <div class="btn-row" style="margin-top:0">
        <input id="scanManual" placeholder="No. induk santri" style="flex:1">
        <button class="btn" onclick="onScanDetected(val('scanManual'))">Cari</button>
      </div>
    </div>
    <div id="scanResultCard"></div>
  `;
}
function setScanMode(m){
  scanMode = m;
  renderScanPage();
}
async function startScan(){
  if(!scanMode){ alert('Pilih jenis transaksi (Top Up atau Tarik Tunai) dulu'); return; }
  if(!('BarcodeDetector' in window)){ alert('Perangkat ini tidak mendukung pemindai QR bawaan.'); return; }
  try{
    scanStream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720}, advanced:[{focusMode:'continuous'}] },
      audio:false
    });
  }catch(e){
    alert('Tidak bisa mengakses kamera. Pastikan izin kamera untuk aplikasi ini sudah diberikan.');
    return;
  }
  torchOn = false;
  const area = document.getElementById('scanArea'), startRow = document.getElementById('scanStartRow');
  if(area) area.style.display='block';
  if(startRow) startRow.style.display='none';
  const video = document.getElementById('scanVideo');
  video.srcObject = scanStream;
  await video.play();
  const track = scanStream.getVideoTracks()[0];
  try{ await track.applyConstraints({advanced:[{focusMode:'continuous'}]}); }catch(e){}
  try{
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const torchBtn = document.getElementById('torchBtn');
    if(caps.torch && torchBtn) torchBtn.style.display='inline-block';
  }catch(e){}
  const detector = new BarcodeDetector({formats:['qr_code']});
  scanBusy = false;
  const loop = async ()=>{
    if(!scanStream) return;
    if(!scanBusy){
      scanBusy = true;
      try{
        const codes = await detector.detect(video);
        if(codes && codes[0]){ onScanDetected(codes[0].rawValue); return; }
      }catch(e){}
      scanBusy = false;
    }
    scanRAF = requestAnimationFrame(loop);
  };
  scanRAF = requestAnimationFrame(loop);
}
async function toggleTorch(){
  if(!scanStream) return;
  const track = scanStream.getVideoTracks()[0];
  const next = !torchOn;
  try{
    await track.applyConstraints({advanced:[{torch:next}]});
    torchOn = next;
    const btn = document.getElementById('torchBtn');
    if(btn){
      btn.innerHTML = torchOn ? '&#128294; Matikan Senter' : '&#128294; Nyalakan Senter';
      btn.classList.toggle('btn-accent', torchOn);
    }
  }catch(e){
    alert('Senter tidak didukung di kamera perangkat ini.');
  }
}
function stopScan(rerender){
  if(rerender===undefined) rerender = true;
  if(scanRAF) cancelAnimationFrame(scanRAF);
  scanRAF = null;
  if(scanStream){ scanStream.getTracks().forEach(t=>t.stop()); scanStream = null; }
  torchOn = false;
  if(rerender && currentPage==='scan') renderScanPage();
}
function onScanDetected(text){
  stopScan(false);
  const s = findSantriByCode(text);
  if(!s){
    renderScanPage();
    document.getElementById('scanResultCard').innerHTML = `<div class="card"><p class="muted">QR/kode tidak dikenali, atau santri tidak ditemukan di data.</p></div>`;
    return;
  }
  showModal((scanMode==='setoran'?'Top Up':'Tarik Tunai')+' - '+s.nama, `
    <p class="muted">Saldo saat ini: ${rupiah(saldo(s.id))}</p>
    <label>Jumlah</label>${rupiahInputHtml('sd_jumlah')}
    <label>Keterangan</label><input id="sd_ket" placeholder="${scanMode==='setoran'?'Top up via QR':'Tarik tunai via QR'}">
    <label>Tanggal</label><input id="sd_tgl" type="date" value="${todayStr()}">
    <div class="btn-row">
      <button class="btn btn-accent" onclick="saveTransaksiSaldo('${s.id}','${scanMode}')">Simpan</button>
      <button class="btn" onclick="closeModal(); renderScanPage();">Batal</button>
    </div>
  `);
}

/* ---------- TAGIHAN (SPP dll) ---------- */
function renderTagihanPage(){
  generateTagihanBerulang();
  const bln = bulanStr();
  document.getElementById('content').innerHTML = `
    <h2>Tagihan</h2>
    <div class="card">
      <div class="row">
        <div class="card-title">Bulan berjalan: ${bln}</div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn btn-sm btn-accent" onclick="openBuatTagihan()">+ Buat tagihan</button>
          <button class="btn btn-sm" onclick="openBuatBerulang()">+ Berulang bulanan</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Tagihan berulang (dibuat otomatis tiap bulan)</div>
      <p class="muted">Cocok untuk SPP dan cicilan uang wisuda &mdash; sekali dibuat, tagihan bulan berikutnya otomatis muncul sendiri tiap kali aplikasi dibuka, tanpa perlu bikin manual lagi.</p>
      ${renderBerulangList()}
    </div>
    <div class="card">
      <div class="card-title">Belum bayar bulan ini</div>
      ${renderTagihanList(DB.tagihan.filter(t=>t.bulan===bln && t.status==='belum'))}
    </div>
    <div class="card">
      <div class="card-title">Sudah lunas bulan ini</div>
      ${renderTagihanList(DB.tagihan.filter(t=>t.bulan===bln && t.status==='lunas'))}
    </div>
  `;
}
function renderTagihanList(items){
  if(items.length===0) return '<p class="muted">Tidak ada.</p>';
  const today = todayStr();
  return items.map(t=>{
    const jenis = DB.jenisTagihan.find(j=>j.id===t.jenisId);
    const telat = t.status==='belum' && t.jatuhTempo && t.jatuhTempo<today;
    return `<div class="list-item">
      <div style="flex:1">
        <div class="name">${escapeHtml(santriNama(t.santriId))}</div>
        <div class="sub">${jenis?jenis.nama:'-'} &middot; ${rupiah(t.jumlah)}${t.jatuhTempo?` &middot; jatuh tempo ${t.jatuhTempo}`:''}${t.berulangId?' &middot; <span class="muted">otomatis</span>':''}</div>
        ${telat?`<span class="tag tag-late" style="margin-top:4px;display:inline-block">Terlambat ${daysLate(t.jatuhTempo)} hari</span>`:''}
      </div>
      ${t.status==='belum'?`<button class="btn btn-sm btn-accent" onclick="openBayarTagihan('${t.id}')">Bayar</button>`:`<span class="tag tag-nontakhossus">Lunas &middot; ${t.caraBayar==='saldo'?'Saldo':'Tunai'}</span>`}
    </div>`;
  }).join('');
}
function defaultTempo(){ return bulanStr()+'-10'; }
const KELAS_LIST = ['7','8','9','10','11','12'];
const TARGET_OPTIONS_HTML = `
  <option value="semua">Semua santri</option>
  <option value="putra">Santri Putra</option>
  <option value="putri">Santri Putri</option>
  ${KELAS_LIST.map(k=>`<option value="kelas${k}">Kelas ${k}</option>`).join('')}
  <option value="wisudawan">Wisudawan/i (pilih manual)</option>
  <option value="lulusan">Lulusan</option>
  <option value="manual">Pilih santri manual</option>
`;
function targetLabel(t){
  const map = {semua:'Semua santri', putra:'Santri Putra', putri:'Santri Putri', wisudawan:'Wisudawan/i', lulusan:'Lulusan', manual:'Pilih manual'};
  if(map[t]) return map[t];
  if(t && t.indexOf('kelas')===0) return 'Kelas '+t.slice(5);
  return t||'-';
}
function manualPickerHtml(label, listId, checkClass, preselected){
  preselected = preselected||[];
  return `
    <label>${label}</label>
    <input placeholder="Cari nama santri..." oninput="filterManualListEl('${listId}', this.value)">
    <div class="card" id="${listId}" style="max-height:200px;overflow-y:auto;margin-top:6px">
      ${DB.santri.length===0?'<p class="muted">Belum ada data santri.</p>':DB.santri.map(s=>`
      <label class="manual-pick-row" data-nama="${(s.nama||'').toLowerCase()}">
        <input type="checkbox" class="${checkClass}" value="${s.id}" style="width:auto" ${preselected.includes(s.id)?'checked':''}> ${escapeHtml(s.nama)}
      </label>`).join('')}
    </div>`;
}
function filterManualListEl(listId, q){
  q = (q||'').toLowerCase();
  document.querySelectorAll('#'+listId+' .manual-pick-row').forEach(l=>{
    l.style.display = l.dataset.nama.includes(q) ? 'flex' : 'none';
  });
}
function openBuatTagihan(){
  showModal('Buat Tagihan (sekali, bulan ini saja)', `
    <label>Jenis tagihan</label>
    <select id="tg_jenis">${DB.jenisTagihan.map(j=>`<option value="${j.id}">${escapeHtml(j.nama)}</option>`).join('')}</select>
    <label>Jumlah per santri</label>${rupiahInputHtml('tg_jumlah')}
    <label>Bulan</label><input id="tg_bulan" type="month" value="${bulanStr()}">
    <label>Tanggal jatuh tempo pembayaran</label><input id="tg_tempo" type="date" value="${defaultTempo()}">
    <label>Untuk santri</label>
    <select id="tg_target" onchange="onTagTargetChange()">${TARGET_OPTIONS_HTML}</select>
    <div id="tg_targetBox"></div>
    <div class="btn-row"><button class="btn btn-accent" onclick="buatTagihan()">Buat</button></div>
  `);
}
function onTagTargetChange(){
  const t = val('tg_target');
  const box = document.getElementById('tg_targetBox');
  if(t==='wisudawan') box.innerHTML = manualPickerHtml('Pilih nama wisudawan/i', 'tg_manualList', 'tg-manual-chk');
  else if(t==='manual') box.innerHTML = manualPickerHtml('Pilih santri', 'tg_manualList', 'tg-manual-chk');
  else box.innerHTML = '';
}
function resolveTagihanTargets(target){
  if(target==='semua') return DB.santri.map(s=>s.id);
  if(target==='putra') return DB.santri.filter(s=>s.jenisKelamin==='L').map(s=>s.id);
  if(target==='putri') return DB.santri.filter(s=>s.jenisKelamin==='P').map(s=>s.id);
  if(target==='lulusan') return DB.santri.filter(s=>s.kelas==='Lulus').map(s=>s.id);
  if(target && target.indexOf('kelas')===0){
    const k = target.slice(5);
    return DB.santri.filter(s=>String(s.kelas||'')===k).map(s=>s.id);
  }
  if(target==='wisudawan' || target==='manual'){
    return Array.from(document.querySelectorAll('.tg-manual-chk:checked')).map(c=>c.value);
  }
  return [];
}
function buatTagihan(){
  const jenisId = val('tg_jenis'), jumlah = rupiahVal('tg_jumlah'), bulan = val('tg_bulan'), target = val('tg_target'), tempo = val('tg_tempo');
  if(jumlah<=0){ alert('Jumlah harus lebih dari 0'); return; }
  if(!tempo){ alert('Isi tanggal jatuh tempo pembayaran'); return; }
  const targets = resolveTagihanTargets(target);
  if(targets.length===0){ alert('Tidak ada santri yang cocok dengan pilihan target ini. Cek dulu data jenis kelamin/kelas/status santri di halaman Santri, atau pilih santri secara manual.'); return; }
  targets.forEach(santriId=>{
    const exists = DB.tagihan.find(t=>t.santriId===santriId && t.jenisId===jenisId && t.bulan===bulan);
    if(!exists){
      const tg = {id:'tg'+Date.now()+Math.random(), santriId, jenisId, bulan, jumlah, status:'belum', tglBayar:null, jatuhTempo:tempo};
      DB.tagihan.push(tg);
      queueSync('tagihan', 'upsert', {id:tg.id, santri_id:tg.santriId, jenis_tagihan_id:tg.jenisId, bulan:tg.bulan, jumlah:tg.jumlah, status:tg.status, tgl_bayar:tg.tglBayar, cara_bayar:null, jatuh_tempo:tg.jatuhTempo, berulang_id:null});
    }
  });
  saveDB(DB);
  closeModal();
  renderTagihanPage();
}
function openBayarTagihan(tagihanId){
  const t = DB.tagihan.find(x=>x.id===tagihanId);
  if(!t) return;
  const jenis = DB.jenisTagihan.find(j=>j.id===t.jenisId);
  showModal('Bayar Tagihan - '+escapeHtml(santriNama(t.santriId)), `
    <p class="muted" style="margin-bottom:2px">${jenis?jenis.nama:'-'} &middot; bulan ${t.bulan}</p>
    <p style="font-weight:700;font-size:20px;margin:2px 0 12px">${rupiah(t.jumlah)}</p>
    <p class="muted">Saldo santri saat ini: ${rupiah(saldo(t.santriId))}</p>
    <div class="btn-row">
      <button class="btn btn-accent" onclick="bayarTagihan('${t.id}','tunai')">&#128181; Tunai</button>
      <button class="btn btn-accent" onclick="bayarTagihan('${t.id}','saldo')">&#128179; Dari Saldo</button>
    </div>
  `);
}
function bayarTagihan(tagihanId, cara){
  const t = DB.tagihan.find(x=>x.id===tagihanId);
  if(!t) return;
  const s = DB.santri.find(x=>x.id===t.santriId);
  if(cara==='saldo'){
    if((s.saldo||0) < t.jumlah){ if(!confirm('Saldo santri tidak cukup untuk membayar tagihan ini. Tetap lanjutkan (saldo menjadi minus)?')) return; }
    const jenis = DB.jenisTagihan.find(j=>j.id===t.jenisId);
    const trx = {id:'tr'+Date.now(), santriId: t.santriId, jenis:'bayar', jumlah: t.jumlah, keterangan:'Bayar '+(jenis?jenis.nama:'tagihan')+' - '+t.bulan, tanggal: todayStr()};
    DB.transaksiSaldo.push(trx);
    queueSync('transaksi_saldo', 'upsert', {id:trx.id, santri_id:trx.santriId, jenis:trx.jenis, jumlah:trx.jumlah, keterangan:trx.keterangan, tanggal:trx.tanggal});
  }
  t.status='lunas'; t.tglBayar=todayStr(); t.caraBayar=cara;
  saveDB(DB);
  queueSync('tagihan', 'upsert', {id:t.id, santri_id:t.santriId, jenis_tagihan_id:t.jenisId, bulan:t.bulan, jumlah:t.jumlah, status:t.status, tgl_bayar:t.tglBayar, cara_bayar:t.caraBayar, jatuh_tempo:t.jatuhTempo, berulang_id:t.berulangId||null});
  closeModal();
  renderTagihanPage();
}

/* ---------- TAGIHAN BERULANG (auto-generate tiap bulan, untuk SPP & cicilan wisuda) ---------- */
function renderBerulangList(){
  const list = DB.tagihanBerulang || [];
  if(list.length===0) return '<p class="muted">Belum ada tagihan berulang.</p>';
  return list.map(tb=>{
    const jenis = DB.jenisTagihan.find(j=>j.id===tb.jenisId);
    return `<div class="list-item">
      <div style="flex:1">
        <div class="name">${jenis?jenis.nama:'-'} &middot; ${rupiah(tb.jumlah)}/bulan ${tb.aktif?'':'<span class="tag tag-late" style="margin-left:4px">Nonaktif</span>'}</div>
        <div class="sub">${targetLabel(tb.target)} &middot; jatuh tempo tanggal ${tb.tempoHari} &middot; mulai ${tb.mulaiBulan}</div>
      </div>
      <div class="btn-row" style="margin-top:0">
        <button class="btn btn-sm" onclick="toggleBerulangAktif('${tb.id}')">${tb.aktif?'Nonaktifkan':'Aktifkan'}</button>
        <button class="btn btn-sm btn-danger" onclick="deleteBerulang('${tb.id}')">Hapus</button>
      </div>
    </div>`;
  }).join('');
}
function openBuatBerulang(){
  showModal('Buat Tagihan Berulang Bulanan', `
    <p class="muted">Tagihan akan otomatis dibuat tiap bulan (saat aplikasi dibuka) tanpa perlu diulang manual. Cocok untuk SPP dan cicilan uang wisuda.</p>
    <label>Jenis tagihan</label>
    <select id="tb_jenis">${DB.jenisTagihan.map(j=>`<option value="${j.id}">${escapeHtml(j.nama)}</option>`).join('')}</select>
    <label>Jumlah per santri per bulan</label>${rupiahInputHtml('tb_jumlah')}
    <label>Tanggal jatuh tempo tiap bulan</label>
    <select id="tb_tempoHari">${Array.from({length:28},(_,i)=>i+1).map(d=>`<option value="${d}" ${d===10?'selected':''}>Tanggal ${d}</option>`).join('')}</select>
    <label>Mulai berlaku bulan</label><input id="tb_mulai" type="month" value="${bulanStr()}">
    <label>Untuk santri</label>
    <select id="tb_target" onchange="onBerulangTargetChange()">${TARGET_OPTIONS_HTML}</select>
    <div id="tb_targetBox"></div>
    <div class="btn-row"><button class="btn btn-accent" onclick="saveBerulang()">Simpan &amp; buat tagihan bulan ini</button></div>
  `);
}
function onBerulangTargetChange(){
  const t = val('tb_target');
  const box = document.getElementById('tb_targetBox');
  if(t==='wisudawan') box.innerHTML = manualPickerHtml('Pilih nama wisudawan/i', 'tb_manualList', 'tb-manual-chk');
  else if(t==='manual') box.innerHTML = manualPickerHtml('Pilih santri', 'tb_manualList', 'tb-manual-chk');
  else box.innerHTML = '';
}
function saveBerulang(){
  const jenisId = val('tb_jenis'), jumlah = rupiahVal('tb_jumlah'), tempoHari = parseInt(val('tb_tempoHari'))||10, mulai = val('tb_mulai'), target = val('tb_target');
  if(jumlah<=0){ alert('Jumlah harus lebih dari 0'); return; }
  if(!mulai){ alert('Isi bulan mulai berlaku'); return; }
  let targetManualIds = [];
  if(target==='wisudawan' || target==='manual'){
    targetManualIds = Array.from(document.querySelectorAll('.tb-manual-chk:checked')).map(c=>c.value);
    if(targetManualIds.length===0){ alert('Pilih minimal 1 santri'); return; }
  }
  const tb = {id:'tb'+Date.now(), jenisId, jumlah, target, targetManualIds, tempoHari, mulaiBulan: mulai, aktif:true};
  DB.tagihanBerulang.push(tb);
  saveDB(DB);
  queueSync('tagihan_berulang', 'upsert', {id:tb.id, jenis_tagihan_id:tb.jenisId, jumlah:tb.jumlah, target:tb.target, target_manual_ids:tb.targetManualIds, tempo_hari:tb.tempoHari, mulai_bulan:tb.mulaiBulan, aktif:tb.aktif});
  generateTagihanBerulang();
  closeModal();
  renderTagihanPage();
}
function toggleBerulangAktif(id){
  const tb = DB.tagihanBerulang.find(x=>x.id===id);
  if(!tb) return;
  tb.aktif = !tb.aktif;
  saveDB(DB);
  queueSync('tagihan_berulang', 'upsert', {id:tb.id, jenis_tagihan_id:tb.jenisId, jumlah:tb.jumlah, target:tb.target, target_manual_ids:tb.targetManualIds, tempo_hari:tb.tempoHari, mulai_bulan:tb.mulaiBulan, aktif:tb.aktif});
  renderTagihanPage();
}
function deleteBerulang(id){
  if(!confirm('Hapus tagihan berulang ini? Tagihan bulan-bulan sebelumnya yang sudah terlanjur dibuat tidak akan ikut terhapus.')) return;
  DB.tagihanBerulang = DB.tagihanBerulang.filter(x=>x.id!==id);
  saveDB(DB);
  queueSync('tagihan_berulang', 'delete', {id});
  renderTagihanPage();
}
function nextBulan(b){
  const [y,m] = b.split('-').map(Number);
  const d = new Date(y, m, 1); // m 1-based (Jan=1) dipakai sbg index 0-based bulan berikutnya
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
}
function monthsFromTo(start, end){
  const out = []; let cur = start, guard = 0;
  while(cur<=end && guard<36){ out.push(cur); cur = nextBulan(cur); guard++; }
  return out;
}
function resolveBerulangTargets(tb){
  if(tb.target==='wisudawan' || tb.target==='manual'){
    return (tb.targetManualIds||[]).filter(id=>DB.santri.some(s=>s.id===id));
  }
  return resolveTagihanTargets(tb.target);
}
function generateTagihanBerulang(){
  const curBulan = bulanStr();
  let changed = false;
  (DB.tagihanBerulang||[]).filter(tb=>tb.aktif).forEach(tb=>{
    const months = monthsFromTo(tb.mulaiBulan||curBulan, curBulan);
    months.forEach(bln=>{
      const sudahAda = DB.tagihan.some(t=>t.berulangId===tb.id && t.bulan===bln);
      if(sudahAda) return;
      const targets = resolveBerulangTargets(tb);
      if(targets.length===0) return;
      const tempo = bln+'-'+String(tb.tempoHari||10).padStart(2,'0');
      targets.forEach(santriId=>{
        const exists = DB.tagihan.find(t=>t.santriId===santriId && t.jenisId===tb.jenisId && t.bulan===bln);
        if(!exists){
          const tg = {id:'tg'+Date.now()+Math.random(), santriId, jenisId: tb.jenisId, bulan: bln, jumlah: tb.jumlah, status:'belum', tglBayar:null, jatuhTempo: tempo, berulangId: tb.id};
          DB.tagihan.push(tg);
          queueSync('tagihan', 'upsert', {id:tg.id, santri_id:tg.santriId, jenis_tagihan_id:tg.jenisId, bulan:tg.bulan, jumlah:tg.jumlah, status:tg.status, tgl_bayar:tg.tglBayar, cara_bayar:null, jatuh_tempo:tg.jatuhTempo, berulang_id:tg.berulangId});
          changed = true;
        }
      });
    });
  });
  if(changed) saveDB(DB);
}

/* ---------- IURAN / SOSIAL ---------- */
function renderIuranPage(){
  document.getElementById('content').innerHTML = `
    <div class="row"><h2>Iuran / Sosial</h2><button class="btn btn-accent btn-sm" onclick="openIuranForm()">+ Buat iuran</button></div>
    ${DB.iuran.length===0?'<div class="card"><p class="muted">Belum ada catatan iuran.</p></div>':DB.iuran.slice().reverse().map(it=>{
      const totalLunas = it.items.filter(i=>i.status==='lunas').length;
      return `<div class="card">
        <div class="card-title">${escapeHtml(it.keterangan)}</div>
        <p class="muted" style="margin-top:0">${it.tanggal} &middot; ${totalLunas}/${it.items.length} santri lunas &middot; total ${rupiah(it.items.reduce((a,b)=>a+b.jumlah,0))}</p>
        ${it.items.map(i=>`
          <div class="list-item">
            <div style="flex:1"><div class="name">${escapeHtml(santriNama(i.santriId))}</div><div class="sub">${rupiah(i.jumlah)}</div></div>
            ${i.status==='belum'?`<button class="btn btn-sm btn-accent" onclick="openBayarIuran('${it.id}','${i.id}')">Bayar</button>`:`<span class="tag tag-nontakhossus">Lunas &middot; ${i.caraBayar==='saldo'?'Saldo':'Tunai'}</span>`}
          </div>`).join('')}
      </div>`;
    }).join('')}
  `;
}
function openIuranForm(){
  showModal('Buat Iuran / Sosial', `
    <label>Keterangan</label><input id="iu_ket" placeholder="Contoh: Bantu biaya RS - Ahmad">
    <label>Tanggal</label><input id="iu_tgl" type="date" value="${todayStr()}">
    <label>Jumlah per santri (yang dicentang)</label>${rupiahInputHtml('iu_jumlah')}
    <label>Pilih santri</label>
    <div class="card" style="max-height:200px;overflow-y:auto">
      ${DB.santri.map(s=>`<label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text);margin:6px 0">
        <input type="checkbox" class="iu-chk" value="${s.id}" style="width:auto"> ${escapeHtml(s.nama)}
      </label>`).join('')}
    </div>
    <div class="btn-row"><button class="btn btn-accent" onclick="saveIuran()">Simpan tagihan iuran</button></div>
  `);
}
function saveIuran(){
  const jumlah = rupiahVal('iu_jumlah');
  const ket = val('iu_ket');
  const checked = Array.from(document.querySelectorAll('.iu-chk:checked')).map(c=>c.value);
  if(!ket || jumlah<=0 || checked.length===0){ alert('Lengkapi keterangan, jumlah, dan pilih minimal 1 santri'); return; }
  const items = checked.map(santriId=>({id:'iui'+Date.now()+Math.random(), santriId, jumlah, status:'belum', caraBayar:null, tglBayar:null}));
  const iu = {id:'iu'+Date.now(), tanggal: val('iu_tgl'), keterangan: ket, items};
  DB.iuran.push(iu);
  saveDB(DB);
  queueSync('iuran', 'upsert', {id:iu.id, tanggal:iu.tanggal, keterangan:iu.keterangan});
  items.forEach(i=>{
    queueSync('iuran_detail', 'upsert', {id:i.id, iuran_id:iu.id, santri_id:i.santriId, jumlah:i.jumlah, status:i.status, cara_bayar:i.caraBayar, tgl_bayar:i.tglBayar});
  });
  closeModal();
  renderIuranPage();
}
function openBayarIuran(iuranId, itemId){
  const it = DB.iuran.find(x=>x.id===iuranId);
  const item = it && it.items.find(x=>x.id===itemId);
  if(!item) return;
  showModal('Bayar Iuran - '+escapeHtml(santriNama(item.santriId)), `
    <p class="muted" style="margin-bottom:2px">${escapeHtml(it.keterangan)}</p>
    <p style="font-weight:700;font-size:20px;margin:2px 0 12px">${rupiah(item.jumlah)}</p>
    <p class="muted">Saldo santri saat ini: ${rupiah(saldo(item.santriId))}</p>
    <div class="btn-row">
      <button class="btn btn-accent" onclick="bayarIuran('${iuranId}','${itemId}','tunai')">&#128181; Tunai</button>
      <button class="btn btn-accent" onclick="bayarIuran('${iuranId}','${itemId}','saldo')">&#128179; Dari Saldo</button>
    </div>
  `);
}
function bayarIuran(iuranId, itemId, cara){
  const it = DB.iuran.find(x=>x.id===iuranId);
  const item = it && it.items.find(x=>x.id===itemId);
  if(!item) return;
  const s = DB.santri.find(x=>x.id===item.santriId);
  if(cara==='saldo'){
    if((s.saldo||0) < item.jumlah){ if(!confirm('Saldo santri tidak cukup untuk membayar iuran ini. Tetap lanjutkan (saldo menjadi minus)?')) return; }
    s.saldo = (s.saldo||0) - item.jumlah;
    const trx = {id:'tr'+Date.now(), santriId: item.santriId, jenis:'bayar', jumlah: item.jumlah, keterangan:'Bayar iuran - '+it.keterangan, tanggal: todayStr()};
    DB.transaksiSaldo.push(trx);
    queueSync('transaksi_saldo', 'upsert', {id:trx.id, santri_id:trx.santriId, jenis:trx.jenis, jumlah:trx.jumlah, keterangan:trx.keterangan, tanggal:trx.tanggal});
  }
  item.status='lunas'; item.tglBayar=todayStr(); item.caraBayar=cara;
  saveDB(DB);
  queueSync('iuran_detail', 'upsert', {id:item.id, iuran_id:it.id, santri_id:item.santriId, jumlah:item.jumlah, status:item.status, cara_bayar:item.caraBayar, tgl_bayar:item.tglBayar});
  closeModal();
  renderIuranPage();
}

/* ---------- RIWAYAT ---------- */
let riwSantriId = null, riwFrom='', riwTo=todayStr();
function renderRiwayatPage(){
  if(!riwFrom){ const d=new Date(); d.setDate(d.getDate()-30); riwFrom=d.toISOString().slice(0,10); }
  if(!riwSantriId && DB.santri[0]) riwSantriId = DB.santri[0].id;
  document.getElementById('content').innerHTML = `
    <h2>Riwayat Transaksi</h2>
    <div class="card">
      <label>Santri</label>
      <select onchange="riwSantriId=this.value; renderRiwayatPage()">
        ${DB.santri.map(s=>`<option value="${s.id}" ${s.id===riwSantriId?'selected':''}>${escapeHtml(s.nama)}</option>`).join('')}
      </select>
      <div class="grid2">
        <div><label>Dari tanggal</label><input type="date" value="${riwFrom}" onchange="riwFrom=this.value; renderRiwayatPage()"></div>
        <div><label>Sampai tanggal</label><input type="date" value="${riwTo}" onchange="riwTo=this.value; renderRiwayatPage()"></div>
      </div>
    </div>
    <div id="riwBody"></div>
  `;
  if(riwSantriId) renderRiwayatBody();
}
function renderRiwayatBody(){
  const jenisLabel = {setoran:'Setoran', tarik:'Tarik tunai', bayar:'Bayar tagihan/iuran (saldo)'};
  const sd = DB.transaksiSaldo.filter(t=>t.santriId===riwSantriId && t.tanggal>=riwFrom && t.tanggal<=riwTo)
    .map(t=>({tanggal:t.tanggal, jenis: jenisLabel[t.jenis]||t.jenis, jumlah: t.jenis==='setoran'?t.jumlah:-t.jumlah, ket:t.keterangan}));
  const belanja = getBelanjaKasir(riwSantriId, riwFrom, riwTo);
  const all = [...sd, ...belanja].sort((a,b)=>a.tanggal.localeCompare(b.tanggal));

  const totalHari={}, totalMinggu={}, totalBulan={}, totalTahun={};
  all.forEach(t=>{
    const d = t.tanggal;
    totalHari[d] = (totalHari[d]||0)+t.jumlah;
    const w = weekKey(d); totalMinggu[w]=(totalMinggu[w]||0)+t.jumlah;
    const m = d.slice(0,7); totalBulan[m]=(totalBulan[m]||0)+t.jumlah;
    const y = d.slice(0,4); totalTahun[y]=(totalTahun[y]||0)+t.jumlah;
  });

  document.getElementById('riwBody').innerHTML = `
    <div class="card">
      <div class="card-title">Daftar transaksi (${all.length})</div>
      ${all.length===0?'<p class="muted">Tidak ada transaksi pada periode ini.</p>':`<table><tr><th>Tanggal</th><th>Jenis</th><th>Keterangan</th><th>Nominal</th></tr>
      ${all.map(t=>`<tr><td>${t.tanggal}</td><td>${t.jenis}</td><td>${escapeHtml(t.ket)||'-'}</td><td style="color:${t.jumlah<0?'#c0392b':'#2f7d4f'}">${t.jumlah<0?'-':'+'}${rupiah(Math.abs(t.jumlah))}</td></tr>`).join('')}
      </table>`}
    </div>
    <div class="card">
      <div class="card-title">Rekap total (bersih)</div>
      <table>
        <tr><th>Per hari (terakhir)</th><td>${recapLast(totalHari)}</td></tr>
        <tr><th>Per minggu (terakhir)</th><td>${recapLast(totalMinggu)}</td></tr>
        <tr><th>Per bulan (terakhir)</th><td>${recapLast(totalBulan)}</td></tr>
        <tr><th>Per tahun (terakhir)</th><td>${recapLast(totalTahun)}</td></tr>
      </table>
    </div>
  `;
}
function recapLast(obj){
  const keys = Object.keys(obj).sort();
  if(keys.length===0) return '-';
  const k = keys[keys.length-1];
  return `${k}: ${rupiah(obj[k])}`;
}
function weekKey(dateStr){
  const d = new Date(dateStr);
  const onejan = new Date(d.getFullYear(),0,1);
  const week = Math.ceil((((d-onejan)/86400000)+onejan.getDay()+1)/7);
  return d.getFullYear()+'-W'+week;
}
function getBelanjaKasir(santriId, from, to){
  // Sumber: tabel transaksi_toko di Supabase (ditarik saat pullAll), sama seperti yang dipakai Aplikasi Wali Santri.
  return (DB.transaksiToko||[]).filter(t=>t.santriId===santriId && t.tanggal>=from && t.tanggal<=to)
    .map(t=>({tanggal:t.tanggal, jenis:'Belanja (Kasir)', jumlah:-(t.total||0), ket: t.catatan||'Belanja warung'}));
}

/* ---------- DATA SANTRI (sinkron) ---------- */
function labelJK(jk){ return jk==='L'?'Putra':jk==='P'?'Putri':'-'; }
function labelKelas(k){ return k==='Lulus'?'Lulus':(k?('Kelas '+k):'-'); }
/* Kumpulkan status bayar (tagihan + iuran) seorang santri: yang belum lunas & riwayat yang sudah lunas.
   Dipakai di tab Data Santri supaya bendahara langsung tahu siapa yang nunggak, tanpa tanya admin pusat. */
function getRingkasanBayarSantri(santriId){
  const today = todayStr();
  const belum = [], lunas = [];
  DB.tagihan.filter(t=>t.santriId===santriId).forEach(t=>{
    const jenis = DB.jenisTagihan.find(j=>j.id===t.jenisId);
    const label = escapeHtml(jenis?jenis.nama:'Tagihan') + (t.bulan?(' &middot; '+escapeHtml(t.bulan)):'');
    if(t.status==='belum'){
      const telat = t.jatuhTempo && t.jatuhTempo<today;
      belum.push({tipe:'tagihan', id:t.id, label, jumlah:t.jumlah, urut:t.jatuhTempo||t.bulan||'', telat, telatHari: telat?daysLate(t.jatuhTempo):0});
    }else{
      lunas.push({tipe:'tagihan', id:t.id, label, jumlah:t.jumlah, tanggal:t.tglBayar, cara:t.caraBayar});
    }
  });
  (DB.iuran||[]).forEach(it=>{
    (it.items||[]).filter(i=>i.santriId===santriId).forEach(i=>{
      if(i.status==='belum'){
        belum.push({tipe:'iuran', id:i.id, iuranId:it.id, label:escapeHtml(it.keterangan), jumlah:i.jumlah, urut:it.tanggal, telat:false, telatHari:0});
      }else{
        lunas.push({tipe:'iuran', id:i.id, label:escapeHtml(it.keterangan), jumlah:i.jumlah, tanggal:i.tglBayar, cara:i.caraBayar});
      }
    });
  });
  belum.sort((a,b)=>(a.urut||'').localeCompare(b.urut||''));
  lunas.sort((a,b)=>(b.tanggal||'').localeCompare(a.tanggal||''));
  return {belum, lunas, totalBelum: belum.reduce((a,b)=>a+b.jumlah,0)};
}
function renderSantriPage(){
  document.getElementById('content').innerHTML = `
    <div class="row"><h2>Data Santri</h2><button class="btn btn-sm" onclick="openSync()">Sinkron</button></div>
    <p class="muted">Data santri (nama, jenis kelamin, kelas, program) ditarik otomatis dari Aplikasi Pondok &mdash; untuk mengubahnya, edit lewat Aplikasi Pondok. Ketuk santri untuk lihat status bayar tagihan &amp; iuran.</p>
    <div class="card">
      ${DB.santri.length===0?'<p class="muted">Belum ada data santri. Sinkronkan dari Aplikasi Pondok.</p>':DB.santri.map(s=>{
        const r = getRingkasanBayarSantri(s.id);
        const adaTelat = r.belum.some(b=>b.telat);
        const statusTag = r.belum.length===0
          ? '<span class="tag tag-nontakhossus">Lunas semua</span>'
          : `<span class="tag ${adaTelat?'tag-late':'tag-takhossus'}">${r.belum.length} belum bayar</span>`;
        return `
        <div class="list-item" style="cursor:pointer" onclick="openDetailSantri('${s.id}')">
          <div class="avatar">${escapeHtml((s.nama||'?').slice(0,2).toUpperCase())}</div>
          <div style="flex:1">
            <div class="name">${escapeHtml(s.nama)}</div>
            <div class="sub">No. induk ${s.noInduk} &middot; ${labelJK(s.jenisKelamin)} &middot; ${labelKelas(s.kelas)} &middot; ${s.program||'-'}</div>
            <div style="margin-top:4px">${statusTag}</div>
          </div>
          <div style="font-weight:700;text-align:right">${rupiah(s.saldo)}<div class="muted" style="font-weight:400;font-size:12px">Saldo</div></div>
        </div>`;}).join('')}
    </div>
  `;
}
function openDetailSantri(santriId){
  const s = DB.santri.find(x=>x.id===santriId); if(!s) return;
  const r = getRingkasanBayarSantri(santriId);
  showModal(s.nama, `
    <p class="muted" style="margin-top:0">No. induk ${s.noInduk} &middot; ${labelJK(s.jenisKelamin)} &middot; ${labelKelas(s.kelas)} &middot; ${s.program||'-'}</p>
    <p style="font-weight:700;font-size:18px;margin:4px 0 16px">Saldo: ${rupiah(s.saldo)}</p>

    <div class="card-title" style="margin-bottom:6px">Belum bayar ${r.belum.length?('&mdash; total '+rupiah(r.totalBelum)):''}</div>
    ${r.belum.length===0?'<p class="muted">Tidak ada tunggakan. Lunas semua.</p>':r.belum.map(b=>`
      <div class="list-item">
        <div style="flex:1">
          <div class="name">${b.label}</div>
          <div class="sub">${rupiah(b.jumlah)}</div>
          ${b.telat?`<span class="tag tag-late" style="margin-top:4px;display:inline-block">Terlambat ${b.telatHari} hari</span>`:''}
        </div>
        <button class="btn btn-sm btn-accent" onclick="closeModal();${b.tipe==='tagihan'?`openBayarTagihan('${b.id}')`:`openBayarIuran('${b.iuranId}','${b.id}')`}">Bayar</button>
      </div>`).join('')}

    <div style="height:1px;background:var(--border);margin:16px 0"></div>

    <div class="card-title" style="margin-bottom:6px">Riwayat sudah lunas</div>
    ${r.lunas.length===0?'<p class="muted">Belum ada riwayat pembayaran.</p>':r.lunas.slice(0,15).map(l=>`
      <div class="list-item">
        <div style="flex:1"><div class="name">${l.label}</div><div class="sub">${rupiah(l.jumlah)} &middot; ${l.tanggal||'-'}</div></div>
        <span class="tag tag-nontakhossus">${l.cara==='saldo'?'Saldo':'Tunai'}</span>
      </div>`).join('')}
  `);
}
function openSync(){
  const pending = (DB.syncQueue||[]).length;
  showModal('Sinkron & Cadangan Data', `
    <p class="muted">${!sb?'Supabase belum dikonfigurasi (isi config.js).':(navigator.onLine? (pending? pending+' data cadangan (dibuat saat offline/gagal kirim) belum berhasil terkirim ke Supabase.' : 'Semua data sudah tersambung ke Supabase.') : 'Sedang offline. Data sementara disimpan di cadangan lokal (IndexedDB) dan akan otomatis terkirim ke Supabase begitu online lagi.')}</p>
    <div class="btn-row">
      <button class="btn btn-accent" onclick="manualSync()" ${!sb?'disabled':''}>&#8635; Sinkron Sekarang</button>
    </div>

    <div style="height:1px;background:var(--border);margin:18px 0"></div>

    <p class="muted">Data santri otomatis ditarik dari Aplikasi Pondok lewat Supabase saat online. Kalau perlu, impor manual dari file export Aplikasi Pondok (JSON) sebagai cadangan &mdash; santri baru akan ditambahkan, santri yang sudah ada saldonya tidak berubah.</p>
    <label>Pilih file export santri (.json)</label>
    <input type="file" accept="application/json" onchange="importSantri(this)">

    <div style="height:1px;background:var(--border);margin:18px 0"></div>

    <p class="muted">Cadangan seluruh data keuangan (santri, saldo, tagihan, iuran, riwayat) &mdash; untuk backup rutin, pindah HP, atau dipakai bersama Aplikasi Toko, Aplikasi Pondok, dan Aplikasi Wali Santri.</p>
    <div class="btn-row">
      <button class="btn btn-accent" onclick="exportKeuanganData()">&#11015; Export Backup</button>
      <label class="btn" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px">
        &#11014; Import Backup
        <input type="file" accept="application/json" style="display:none" onchange="importBackup(this)">
      </label>
    </div>
  `);
}
async function manualSync(){
  if(!sb){ alert('Supabase belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di config.js dulu.'); return; }
  if(!navigator.onLine){ alert('Sedang offline. Sinkron akan berjalan otomatis begitu perangkat online lagi.'); return; }
  closeModal();
  await trySync();
  alert('Sinkron selesai.');
  goPage(currentPage);
}
function importSantri(input){
  const file = input.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const data = JSON.parse(e.target.result);
      const list = data.santri || data;
      let added=0;
      list.forEach(s=>{
        if(!DB.santri.find(x=>x.id===s.id)){
          DB.santri.push({
            id:s.id, nama:s.nama, noInduk:s.noInduk,
            jenisKelamin: s.jenisKelamin || s.jk || s.gender || '',
            kelas: s.kelas || s.kelasNama || s.class || '',
            program: s.program || '',
            saldo:0
          });
          added++;
        }
      });
      saveDB(DB);
      alert(added+' santri baru ditambahkan.');
      closeModal();
      renderBeranda();
    }catch(err){ alert('File tidak valid.'); }
  };
  reader.readAsText(file);
}
function exportKeuanganData(){
  const blob = new Blob([JSON.stringify(DB,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'keuangan-backup-'+todayStr()+'.json';
  a.click();
}
function importBackup(input){
  const file = input.files[0]; if(!file) return;
  if(!confirm('Import backup akan MENGGANTI seluruh data aplikasi saat ini (santri, saldo, tagihan, riwayat, iuran, dll) dengan isi file ini. Pastikan file ini benar. Lanjutkan?')){
    input.value='';
    return;
  }
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const data = JSON.parse(e.target.result);
      if(!data || !Array.isArray(data.santri)){ alert('File backup tidak valid.'); return; }
      DB = normalizeDB(data);
      saveDB(DB);
      alert('Backup berhasil dipulihkan.');
      closeModal();
      goPage('beranda');
    }catch(err){ alert('File tidak valid atau rusak.'); }
    input.value='';
  };
  reader.readAsText(file);
}

/* ---------- KELOLA (jenis tagihan) ---------- */
function renderKelolaPage(){
  document.getElementById('content').innerHTML = `
    <h2>Kelola Jenis Tagihan</h2>
    <p class="muted">Cari cadangan/impor data atau sinkron santri? Buka tombol &#8635; Sinkron di pojok kanan atas.</p>
    <div class="card">
      ${DB.jenisTagihan.map(j=>`<div class="list-item"><div style="flex:1">${escapeHtml(j.nama)}</div><button class="btn btn-sm btn-danger" onclick="delJenisTagihan('${j.id}')">Hapus</button></div>`).join('')}
    </div>
    <div class="card">
      <label>Jenis tagihan baru</label>
      <input id="newJenis" placeholder="Contoh: Biaya Seragam">
      <div class="btn-row"><button class="btn btn-accent" onclick="addJenisTagihan()">Tambah</button></div>
    </div>
  `;
}
function addJenisTagihan(){
  const nama = val('newJenis'); if(!nama) return;
  const jt = {id:'jt'+Date.now(), nama};
  DB.jenisTagihan.push(jt); saveDB(DB);
  queueSync('jenis_tagihan', 'upsert', {id:jt.id, nama:jt.nama});
  renderKelolaPage();
}
function delJenisTagihan(id){ DB.jenisTagihan = DB.jenisTagihan.filter(j=>j.id!==id); saveDB(DB); queueSync('jenis_tagihan', 'delete', {id}); renderKelolaPage(); }

/* ---------- MODAL ---------- */
function showModal(title, bodyHtml){
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal-box">
        <div class="modal-head"><h3>${title}</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>
        ${bodyHtml}
      </div>
    </div>
  `;
}
function closeModal(){ document.getElementById('modalRoot').innerHTML=''; }

/* ---------- INIT ---------- */
if(!sb){
  // config.js belum diisi -> tak ada cara login, tampilkan pesan di layar login saja
  showLoginScreen();
} else {
  sb.auth.onAuthStateChange((event, session)=>{
    if(session){ bootApp(); }
    else { appBooted = false; showLoginScreen(); }
  });
  // onAuthStateChange di atas juga terpanggil sekali di awal (INITIAL_SESSION) dengan
  // status sesi yang tersimpan, jadi tidak perlu memanggil getSession() terpisah.
}
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) stopScan(false); });
