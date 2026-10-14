# Hermes IDE

Ekstensi VS Code yang menjalankan [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) lewat ACP (Agent Client Protocol), dengan endpoint model yang bisa kamu atur sendiri. Rancangan lengkapnya ada di [docs/hermes-ide_prd.md](docs/hermes-ide_prd.md). Status saat ini: **Fase 5 (nyaman dipakai harian: onboarding, rules proyek, checkpoint, pelacak token dan biaya, notifikasi, pemeliharaan Hermes; lihat [Nyaman dipakai harian](#nyaman-dipakai-harian-fase-5))**, di atas Fase 4 ([IDE mandiri](#ide-mandiri-fase-4): VSCodium + branding + installer Windows + auto-update). Di bawahnya Fase 3 (Tab autocomplete dan index codebase) dan panel chat 0.3.6 (timeline aktivitas, mode persetujuan, picker model, riwayat sesi di panel).

## Syarat

- Hermes Agent 0.21.x terpasang (`hermes acp --check` harus OK).
- VS Code 1.95 atau lebih baru. Target utama Windows 10/11.
- Model dengan konteks minimal 64.000 token yang mendukung tool calling.

## Pasang

```powershell
npm install
npm run package          # menghasilkan hermes-ide-0.6.0.vsix
code --install-extension hermes-ide-0.6.0.vsix
```

Buka folder proyek, lalu klik ikon ✦ **Hermes** di activity bar, atau buka tab **Hermes** di Secondary Side Bar (grup yang sama dengan Chat / Codex / Claude Code; VS Code 1.106+). Tombol Hermes di toolbar editor membukanya sebagai tab editor. Semuanya menampilkan percakapan yang sama. Hermes dijalankan saat panel dibuka dan dihentikan saat VS Code ditutup.

Atau pakai **IDE mandiri** (installer Windows yang sudah memuat ekstensi ini): lihat [IDE mandiri (Fase 4)](#ide-mandiri-fase-4).

## Profil endpoint

| Profil | Cara kerja | Kapan dipakai |
| --- | --- | --- |
| **Konfigurasi Hermes** (bawaan) | Memakai provider, base URL, dan key dari config Hermes milikmu (`%LOCALAPPDATA%\hermes\config.yaml`). Model bisa diganti per sesi lewat picker model di composer; pilihan terakhir diingat. | Hermes sudah diatur lewat `hermes model`. |
| **Profil kustom** (bisa banyak, misal "VPS vLLM", "OpenRouter") | Hermes dijalankan dengan `HERMES_HOME` milik IDE. Base URL dan model profil aktif ditulis ke `config.yaml` di sana; API key tiap profil disimpan terpisah di SecretStorage VS Code, dan hanya key profil aktif yang diteruskan lewat environment. | Mencoba endpoint lain tanpa mengubah config Hermes. |

Ganti profil lewat ⚙ di header panel (kartu Custom API) atau dengan mengklik nama model di status bar. Kartu ini hanya tampil saat ⚙ dibuka, tidak menempel di atas chat.

Kenapa profil kustom butuh `HERMES_HOME` sendiri: Hermes membaca provider dan base URL dari `config.yaml` *sebelum* environment, jadi endpoint tidak bisa dialihkan lewat env saja. Profil kustom punya riwayat sesi dan memori sendiri, terpisah dari Hermes CLI. Endpoint dari Fase 1 (`hermes.endpoint.*`) otomatis dipindahkan menjadi profil "Custom API".

**Tes koneksi** (profil kustom) memeriksa URL, key, model, dukungan tool calling, latensi, dan konteks (gagal bila < 64k). Di profil Konfigurasi Hermes, tes membuka sesi lewat Hermes tanpa mengirim prompt.

## Alur kerja

- **Chat**: Enter untuk kirim, Shift+Enter baris baru, Esc atau tombol Stop untuk menghentikan langkah agent. Pesan yang dikirim saat agent masih bekerja masuk antrean di atas composer dan terkirim (digabung jadi satu pesan) begitu giliran selesai; tiap pesan bisa di-Edit atau dihapus, dan **Hentikan & kirim sekarang** menghentikan giliran lalu langsung mengirim antrean. Bila giliran dihentikan dengan Stop atau gagal, antrean tidak terkirim sendiri. Detail tampilan panel ada di bagian [Panel chat](#panel-chat).
- **Konteks**: ketik `@` di composer untuk memilih file atau folder, atau klik **+** untuk memilih file lewat dialog. Seleksi editor ditambahkan dengan **Ctrl+Alt+L** atau klik kanan → *Tambahkan Seleksi ke Chat*; file/folder di Explorer lewat klik kanan → *Tambahkan ke Chat Hermes*. Isi file disematkan langsung ke prompt (maks 200 KB per file).
- **Gambar**: tempel gambar dari clipboard dengan **Ctrl+V** di composer. Gambar tampil sebagai chip `image.png 547×690` dan dikirim ke model sebagai blok gambar ACP.
- **Aktivitas tool**: setiap baca/edit/jalankan tampil di timeline dengan status, durasi, `+tambah -hapus`, serta input (IN) dan output (OUT).
- **Edit file**: Hermes meminta izin sebelum menulis. Diff terbuka di editor; terima dengan **Ctrl+Enter**, tolak dengan **Ctrl+Backspace**, atau dari kartu di panel. Jika ada beberapa hunk, CodeLens di tiap hunk bisa menolak hunk tertentu.
- **Edit inline**: pilih kode, tekan **Ctrl+K**, tulis instruksi. Hermes mengerjakannya di sesi terpisah (riwayat chat tetap bersih), dan hasilnya tampil sebagai diff di grup editor yang sama. Ctrl+K dengan seleksi menggantikan chord Ctrl+K bawaan VS Code; matikan lewat `hermes.inlineEdit.useCtrlK` bila perlu.
- **Sesi agent**: tombol 🕘 di bar sesi panel chat (atau panel *Sesi Agent* di Explorer) menampilkan riwayat sesi workspace ini. Klik untuk melanjutkan (riwayat diputar ulang di panel), ikon tempat sampah untuk menghapus (lewat `hermes sessions delete`, dengan konfirmasi).
- **Server MCP**: tambahkan di bagian *Server MCP* pada kartu Custom API (⚙) (stdio: perintah + argumen; http/sse: URL). Server diteruskan ke Hermes lewat ACP hanya untuk sesi IDE; config Hermes tidak diubah. Hermes menaruh tool MCP di balik `tool_search`, jadi model memanggilnya lewat `tool_call`.
- **Perintah terminal**: kartu izin dengan Izinkan / Izinkan selalu / Tolak untuk **setiap perintah** (lihat bagian berikut). "Izinkan selalu" disimpan per workspace (perintah persis sama) dan bisa dihapus lewat *Hermes: Kelola Perintah Izinkan Selalu*. Perintah berisiko (hapus rekursif, `git push --force`, `git reset --hard`, pipe ke shell, dll.) selalu ditanya.
- **Keandalan**: jika proses Hermes mati, panel menampilkan tombol *Mulai ulang Hermes*; percakapan dilanjutkan lewat `session/load` tanpa reload jendela.
- **Log**: *Hermes: Tampilkan Agent Log* (stderr Hermes + log ekstensi), *Hermes: Ekspor Log* untuk debugging. API key disamarkan di log.

## Panel chat

Susunan panel dari atas ke bawah: header (status ACP dan ⚙), bar sesi, transkrip, lalu composer.

### Bar sesi

- Menampilkan judul sesi aktif. Sebelum Hermes memberi judul, baris pertama pesan pertamamu yang dipakai.
- **+** memulai sesi baru. **🕘** membuka riwayat sesi dengan kotak pencarian; waktu ditulis ringkas (`baru`, `5m`, `3j`, `2h`), sesi aktif dicetak tebal dan diberi spinner saat agent berjalan. Navigasi dengan ↑↓, Enter, Esc. Tombol hapus muncul saat baris di-hover.

### Transkrip

- Setiap pesanmu memulai satu giliran: jam kirim, chip konteks (termasuk gambar), lalu pesannya.
- Semua yang dilakukan agent sesudahnya tampil di **timeline** vertikal, satu titik per langkah:
  - **Berpikir selama N dtk**: klik untuk membaca isi pikiran agent.
  - **Teks jawaban** beserta jamnya.
  - **Tool**, dengan judul bergaya `Bash  Check changes since the last package` lalu kotak **IN** (perintah atau input) dan **OUT** (output). Saat tertutup, IN tampil satu baris dan OUT beberapa baris yang memudar; klik kotaknya untuk membuka semua. Path file di judul bisa diklik untuk membuka file.
  - Kartu izin dan pemberitahuan juga masuk ke timeline.
  - Warna titik: hijau selesai, merah gagal, kuning berkedip sedang berjalan.
- Selama agent bekerja, baris terakhir timeline menampilkan indikator seperti **✻ Mulling… (12 dtk · ↓ ~56 token)**. Kata kerjanya berganti tiap beberapa detik. Indikator disembunyikan saat agent menunggu izin darimu.

### Composer

Bar di bawah kotak teks, dari kiri ke kanan: **+**, **/**, picker model, pemakaian konteks, tombol mode, tombol kirim/stop.

| Kontrol | Fungsi |
| --- | --- |
| **+** | Dialog pilih file; file yang dipilih jadi chip konteks. File gambar dikirim sebagai gambar. |
| **/** (atau ketik `/` di awal composer) | Menu perintah. Teks setelah `/` menyaring isi menu, misal `/eks`. |
| Picker model | Popover dengan pencarian, bagian *Terakhir dipakai*, grup per provider, nama model yang dirapikan (`claude-opus-4-5-20251101` → **Claude Opus 4.5**, ID asli tetap tampil di bawahnya), dan ✓ di model aktif. |
| Mode | Pilih mode persetujuan (lihat bagian berikut). **Shift+Tab** di composer berpindah ke mode berikutnya. |

Isi menu `/`:

| Bagian | Perintah |
| --- | --- |
| Konteks | Lampirkan file, Sebut file dari proyek ini (menyisipkan `@`), Bersihkan percakapan (sesi baru), Ekspor percakapan (transkrip dibuka sebagai dokumen Markdown baru) |
| Sesi | Riwayat sesi |
| Model | Ganti model, Ganti mode |
| Hermes | Pengaturan Custom API, Buka Agent Log, Mulai ulang Hermes |

Di panel yang sempit, bagian yang kurang penting disembunyikan lebih dulu: angka pemakaian konteks, lalu label mode (tinggal ikon), lalu tombol `/` (menu tetap bisa dibuka dengan mengetik `/`).

## Mode persetujuan

Mode menentukan apa yang disetujui otomatis. Mode diterapkan oleh ekstensi; Hermes sendiri selalu dijalankan dalam mode `default` agar semua edit dan perintah tetap lewat kartu izin di panel. Mode tersimpan per workspace.

| Mode | Edit file | Perintah terminal | Catatan |
| --- | --- | --- | --- |
| **Manual** (bawaan) | Diff review dulu | Ditanya | Perilaku sebelum 0.3.6 |
| **Edit otomatis** | Langsung diterapkan | Ditanya | |
| **Plan** | Ditolak otomatis | Ditanya | Pesanmu diberi instruksi untuk menjelajahi kode dan menyusun rencana tanpa mengubah apa pun |
| **Ask** | Ditolak otomatis | Ditolak otomatis, termasuk yang ada di daftar izinkan selalu | Tanya-jawab baca-saja ala Cursor; agent tetap boleh membaca dan mencari file |
| **Auto** | Langsung diterapkan | Langsung jalan, kecuali yang berisiko | |
| **Super Auto** | Langsung diterapkan, termasuk di luar workspace dan file yang belum disimpan | Langsung jalan, termasuk yang berisiko dan `execute_code` | Hanya deploy ke server dan perintah jaringan di mode lokal penuh yang ditanya. Peringatan risiko tetap tercatat di timeline |

Pengaman yang tetap berlaku di semua mode selain Super Auto:

- Edit ke file di luar workspace atau ke file yang punya perubahan belum disimpan selalu lewat diff review.
- Perintah berisiko (lihat daftar di *Alur kerja*) dan `execute_code` selalu ditanya, juga di mode Auto.
- "Ditanya" berarti lewat kartu izin; perintah yang ada di daftar *izinkan selalu* tetap jalan tanpa ditanya, kecuali di mode Ask.
- Langkah yang diputuskan otomatis tetap tercatat di timeline, misalnya "Diterapkan otomatis" atau "Dilewati — mode Ask hanya membaca".

## Fitur di luar Hermes (Fase 3)

Dua fitur ini memanggil endpoint model sendiri, terpisah dari Hermes, dengan base URL, model, dan API key masing-masing (key di SecretStorage). Atur keduanya di kartu Custom API.

### Tab autocomplete (F-17)

- Saran inline dari model *fill-in-the-middle* lewat endpoint OpenAI-compatible `/completions` (Ollama, vLLM, llama.cpp, LM Studio, dll.). Tekan **Tab** untuk menerima.
- Format FIM dipilih otomatis dari nama model: Qwen2.5-Coder, StarCoder, CodeLlama, DeepSeek-Coder. Model lain memakai parameter `suffix` yang diterapkan server.
- Saran satu baris di tengah baris, multi-baris setelah `{`, `(`, `:` atau di baris kosong. Ada debounce (`hermes.completion.debounceMs`, default 120 ms), pembatalan saat terus mengetik, cache, dan lanjutan saran saat kamu mengetik huruf yang sama dengan saran.
- Status bar menampilkan **Tab** beserta latensi rata-rata; klik untuk menyalakan/mematikan.
- Overhead ekstensi sendiri sekitar 10 ms. Target "< 500 ms" bergantung pada model: pakai model kecil yang dekat (misal `qwen2.5-coder:1.5b` lokal).

### Index codebase (F-18)

- File workspace dipecah per 60 baris (tumpang tindih 12), di-embed lewat `/embeddings`, dan disimpan lokal di storage workspace VS Code (`index.bin` + `index.json`, tanpa dependensi native).
- Pembaruan inkremental: hanya file yang ukuran/mtime-nya berubah yang di-embed ulang, sekitar 2 detik setelah file disimpan atau dibuat. Lockfile, file biner, hasil build, dan file di atas `hermes.index.maxFileKB` dilewati.
- Dipakai lewat tiga cara:
  - **`@codebase`** di composer: potongan kode paling relevan untuk pesanmu disematkan ke prompt.
  - **Tool `codebase_search` untuk Hermes**: ekstensi menjalankan server MCP kecil di `127.0.0.1` (dengan token per sesi) dan meneruskannya ke Hermes, sehingga agent bisa mencari sendiri. Hermes memanggilnya lewat `tool_call`.
  - Perintah *Hermes: Cari di Codebase (Semantik)* untuk mencari dan membuka hasil.

## IDE mandiri (Fase 4)

Hermes IDE juga dikirim sebagai IDE sendiri: [VSCodium](https://vscodium.com) resmi dengan branding Hermes IDE, ekstensi ini sebagai built-in, dan installer Windows dengan update otomatis.

**Tidak ada fork dan tidak ada build VS Code dari source.** Skrip build mengunduh rilis VSCodium yang dipin (versi dan SHA-256 ada di [ide/brand.json](ide/brand.json); unduhan ditolak bila checksum beda), lalu hanya mengganti `product.json`, launcher, ikon, dan metadata exe. Kode inti VS Code tidak disentuh, jadi tidak ada upstream yang harus di-merge. (Fork baru perlu bila kamu ingin mengubah workbench itu sendiri, misalnya menghapus UI chat bawaan di level source; itu bukan syarat Fase 4.)

### Isi paket

| Bagian | Cara |
| --- | --- |
| Basis | VSCodium 1.135.06055 (x64; arm64 ada di skrip tapi belum diuji) |
| Branding | `product.json`: nama, folder data `~/.hermes-ide`, mutex, ID installer sendiri, protokol `hermes-ide://`. Ikon dan versi exe lewat rcedit. Perintah terminal `hermes-ide` (bukan `hermes`, itu CLI Hermes Agent). |
| Ekstensi | `hermes-ide-<versi>.vsix` diekstrak ke `resources/app/extensions/hermes-ide` sebagai built-in. Versi lebih baru dari Open VSX tetap menimpanya. |
| Galeri ekstensi | Open VSX. Build gagal bila basis tidak memakainya. |
| Default | Telemetry mati, UI chat bawaan (Copilot) disembunyikan (`chat.disableAIFeatures`), tanpa tab Welcome. Semuanya bisa diubah pengguna. |
| Dibuang | Feed update VSCodium, URL server REH VSCodium, CLSID menu konteks Windows 11 VSCodium, folder `policies` |

### Membangun

```powershell
npm install
npm run ide:build        # ekstensi -> stage -> installer + latest.json (kompresi cepat, ±4 menit)
npm run ide:release      # sama, kompresi maksimal (lambat; dipakai CI)
npm run ide:stage        # hanya folder stage, tanpa installer
npm run ide:smoke        # jalankan IDE hasil build, cek ekstensi built-in benar-benar aktif
```

Hasil di `ide/out/`: `x64/stage/` (IDE siap jalan tanpa instal), `x64/HermesIDE-Setup-x64-<versi>.exe` (+ `.sha256`), dan `latest.json`. Build pertama mengunduh ±250 MB VSCodium ke `ide/.cache/`. Versi IDE sama dengan versi di `package.json`; `--version X.Y.Z` menimpanya (untuk menguji update).

### Installer

Per-pengguna: tanpa prompt admin, terpasang di `%LOCALAPPDATA%\Programs\Hermes IDE` (bisa diubah; mode admin tersedia lewat dialog Inno). Pilihan di wizard: shortcut desktop, menu konteks Explorer (*Open with Hermes IDE* untuk file, folder, dan latar folder), dan `hermes-ide` di PATH. Uninstall lewat *Apps & features* menghapus semuanya, termasuk entri PATH dan menu konteks. Folder instalasi yang terlalu panjang ditolak di awal (batas path 260 karakter Windows), bukan gagal di tengah jalan.

### Update otomatis

VS Code punya updater bawaan, tapi tidak bisa dipakai di sini: zip VSCodium tidak berisi `inno_updater.exe`, dan `updateUrl` bawaannya menunjuk ke feed VSCodium sehingga akan mengganti Hermes IDE dengan VSCodium. Karena itu `updateUrl` dibuang dan updater dibuat di ekstensi ([src/core/updater.ts](src/core/updater.ts), [src/vscode/ideUpdater.ts](src/vscode/ideUpdater.ts)). Updater hanya aktif bila `product.json` punya blok `hermesIde` (artinya berjalan di IDE mandiri); di VS Code biasa perintahnya hanya menjelaskan hal itu.

1. 20 detik setelah IDE dibuka, lalu tiap 12 jam, ekstensi mengambil `latest.json` (satu GET; tidak ada kode, prompt, atau data lain yang dikirim). Bisa dimatikan lewat `hermes.update.check`. Manual: *Hermes: Periksa Pembaruan IDE*.
2. Jika versi di feed lebih baru, muncul notifikasi **Perbarui & mulai ulang** / Nanti / Lewati versi ini.
3. Installer diunduh ke folder temp. Ukuran dan SHA-256 harus sama dengan feed; bila tidak, file dihapus dan update dibatalkan. URL harus https.
4. Jika ada file belum disimpan, kamu ditanya dulu (*Simpan & perbarui*).
5. Installer dijalankan senyap (`/VERYSILENT /UPDATE=1`), IDE ditutup. Installer menunggu IDE benar-benar keluar, mengganti file di folder yang sama, lalu membuka IDE kembali.

Feed (`latest.json`) dibuat oleh skrip build:

```json
{ "schema": 1, "version": "0.4.0", "releasedAt": "...", "notes": "",
  "installers": { "win32-x64": { "url": "https://github.com/.../HermesIDE-Setup-x64-0.4.0.exe", "sha256": "...", "size": 229960414 } } }
```

`hermes.update.feedUrl` mengganti URL feed (mirror atau uji lokal). Kedua setting update berskala *application*, jadi `.vscode/settings.json` sebuah proyek tidak bisa mengarahkan IDE ke feed lain.

Satu jebakan yang sudah ditangani: extension host berjalan dengan `ELECTRON_RUN_AS_NODE` dan `VSCODE_*`. Bila diwariskan ke installer, IDE yang dibuka ulang akan berjalan sebagai Node biasa dan tidak muncul. `cleanLaunchEnv` membuang variabel itu sebelum installer dijalankan.

### Rilis

Push tag yang sama dengan versi di `package.json` (`git tag v0.4.0 && git push origin v0.4.0`) menjalankan [.github/workflows/release-ide.yml](.github/workflows/release-ide.yml): typecheck, unit test, build installer, smoke test, lalu GitHub Release berisi installer, `.sha256`, `latest.json`, dan `.vsix`. IDE membaca feed dari `https://github.com/myahyazahid/hermes-ide/releases/latest/download/latest.json` (diatur di `ide/brand.json`; ubah bila nama repo berbeda). Workflow ini belum pernah dijalankan di GitHub. Tanpa CI: jalankan `npm run ide:release`, lalu unggah `.exe` dan `ide/out/latest.json` ke release secara manual.

### Open VSX

IDE memasang ekstensi dari Open VSX (bawaan VSCodium). Untuk mempublikasikan ekstensi ini ke sana, sekali saja: buat akun Eclipse dan tanda tangani Publisher Agreement, buat access token di open-vsx.org, lalu `npx ovsx create-namespace yahya -p <token>`. Setelahnya:

```powershell
npm run package
npm run publish:openvsx -- --dry-run     # cek tanpa mempublikasikan
$env:OVSX_PAT = "<token>"; npm run publish:openvsx
```

Skrip menolak mempublikasikan selama `license` di `package.json` masih `UNLICENSED` (pertanyaan terbuka di PRD: MIT/Apache atau tertutup); pakai `--allow-unlicensed` bila itu disengaja. Publikasi bersifat publik dan nomor versi tidak bisa dipakai ulang. Di workflow, langkah ini baru jalan bila variabel repositori `PUBLISH_OPENVSX=true` dan secret `OVSX_PAT` ada.

### Cara ini diuji

| Tes | Yang dibuktikan |
| --- | --- |
| `npm test` | Pembaruan `product.json`, launcher, ikon `.ico`, feed, perbandingan versi, validasi feed, pembersihan env, unduhan dengan checksum (server HTTP lokal: sukses, redirect, checksum salah, terpotong, kebesaran, 404) |
| `npm run test:vscode` | Di extension host VS Code sungguhan: updater diam di VS Code biasa; sebagai IDE mandiri ia menemukan rilis baru, mengunduh dan memverifikasi, menyerahkan ke installer (diganti stub) dan meminta IDE keluar; versi yang dilewati tidak diumumkan lagi |
| `npm run ide:smoke` | Menjalankan IDE hasil build (stage atau salinan terpasang) dan memastikan ekstensi built-in aktif lewat log extension host |
| `ide\scripts\e2e-install.ps1` | Di mesin ini: install baru, upgrade di tempat saat IDE terbuka (installer menunggu IDE keluar, mengganti file, membuka IDE lagi), uninstall, dan PATH/registry kembali persis seperti semula. Menulis lalu menghapus entri registry per-pengguna. |

Yang **tidak** diuji otomatis: klik tombol *Perbarui & mulai ulang* di UI IDE sungguhan (butuh otomasi UI); tes di atas menjalankan langkah installer-nya dengan perintah yang sama persis dengan yang dijalankan ekstensi.

### Batasan Fase 4

- **Installer belum ditandatangani (Authenticode).** Windows SmartScreen akan memperingatkan bila installer diunduh lewat browser. Update dari dalam IDE tidak lewat browser, tetapi file tetap tidak bertanda tangan. Untuk distribusi ke orang lain, sertifikat code signing sebaiknya menyusul.
- **Wizard installer berbahasa Inggris** (Inno Setup tidak punya terjemahan Indonesia resmi). IDE dan ekstensinya tetap dwibahasa.
- **Hanya x64 yang diuji.** Jalur arm64 ada di skrip, belum dicoba di perangkat sungguhan, dan tidak ada di workflow.
- **Panjang path instalasi** dibatasi (±120 karakter, dihitung saat build) karena batas 260 karakter Windows.
- **Ekstensi khusus Microsoft Marketplace** (C#, Pylance, Remote-SSH, dll.) tidak tersedia di Open VSX.
- **IDE tidak membawa Hermes Agent.** `hermes` harus sudah terpasang (onboarding otomatis adalah Fase 5).
- **Update butuh satu klik** dan belum punya rollback otomatis; versi lama bisa dipasang ulang dari halaman rilis.
- **Menaikkan basis VSCodium**: ubah `base.version` dan `sha256` di `ide/brand.json` (checksum ada di file `.sha256` pada halaman rilis VSCodium), lalu `npm run ide:build`. Build berhenti dengan pesan jelas bila bentuk `product.json` atau skrip launcher upstream berubah.
- **Lisensi**: `LICENSE.txt` VSCodium (MIT) ikut terpasang di `resources/app`. Lisensi ekstensi sendiri masih `UNLICENSED` sampai kamu memutuskan.

## Nyaman dipakai harian (Fase 5)

Enam hal yang membuat pemakaian sehari-hari lebih aman dan tidak canggung: onboarding, rules proyek, checkpoint, pelacak token dan biaya, notifikasi, dan pemeliharaan Hermes.

### Mulai cepat (onboarding)

Chat yang kosong menampilkan kartu **Mulai cepat** dengan tiga langkah. Kartu hilang setelah pesan pertama atau lewat *Sembunyikan*; pengguna yang sudah pernah memakai chat di workspace itu tidak melihatnya.

1. **Hermes Agent.** Jika belum terpasang (Windows), tombol *Pasang Hermes* menjalankan installer resmi di terminal yang terlihat. Instalasinya **dipin ke build yang dites** (v0.21.4, commit `c0d72947`, lewat parameter `-Commit` milik installer Hermes), bukan `main` hari ini. Installer Hermes lalu menjalankan wizard provider-nya sendiri, dan panel memeriksa ulang otomatis.
2. **Model.** Preset (OpenRouter, Ollama, vLLM) mengisi form Custom API dengan nama dan base URL; kamu tinggal mengisi model dan key. Atau *Atur model lewat wizard Hermes* (`hermes model`) bila memakai config Hermes.
3. **Coba tugas pertama.** Tiga prompt awal; klik salah satu untuk memasukkannya ke kotak pesan.

Installer IDE punya pilihan yang sama: *Install Hermes Agent* hanya muncul bila Hermes belum ada, dan tercentang untuk pengguna baru. Ia tidak pernah berjalan pada instalasi senyap kecuali diminta dengan `/INSTALLHERMES=1`, dan tidak pernah saat update.

### Versi Hermes dan pembaruannya

IDE dites dengan Hermes `>=0.21.0 <0.22.0` (build uji: 0.21.4). Di ⚙ → *Hermes Agent* kamu melihat apakah versi terpasang ada di dalam rentang itu, dan:

- **Periksa pembaruan** menjalankan `hermes update --check` (hanya membaca). Seminggu sekali ini juga dijalankan otomatis dan **hanya memberi tahu** (matikan lewat `hermes.hermesUpdate.check`). Hermes sendiri yang menghubungi repositorinya; IDE tidak mengirim apa pun.
- **Perbarui…** meminta konfirmasi, membuat backup penuh (`--backup`), menghentikan Hermes selama pembaruan, menjalankan `hermes update --yes`, lalu menyalakan Hermes lagi dan memeriksa versinya. Jika hasilnya di luar rentang yang dites, kamu diberi tahu bersama cara memulihkan (`hermes import` dari backup).

Kenapa tidak otomatis penuh: `hermes update` selalu mengikuti branch `main` dan CLI-nya tidak bisa dipin ke versi tertentu. Saat saya mengeceknya, instalasi 0.21.4 sudah lebih dari sepuluh ribu commit di belakang `origin/main` menurut Hermes sendiri, dan rilis bernomor terbaru (v0.21.6) menunjuk ke satu commit tertentu, bukan ujung `main`. Karena itu yang dijamin IDE adalah: **instalasi baru selalu ke build yang dites, pembaruan tidak pernah terjadi tanpa persetujuan, selalu dengan backup, dan hasilnya diperiksa**. Bukan bahwa pembaruan dijamin ke versi yang dites.

### Rules proyek

`.hermes/rules.md` dan/atau `.hermes/rules/*.md` di workspace dikirim ke agent otomatis, jadi konvensi proyek tidak perlu diulang di setiap prompt.

- Dikirim sebagai blok `<project-rules>` di depan pesan pertama tiap sesi, dan lagi **hanya bila isinya berubah**. Jika file dihapus, agent diberi tahu rules itu tidak berlaku lagi.
- Terlihat, tidak tersembunyi: chip **§ Rules** di bar sesi (klik untuk membuka file) dan chip `§ .hermes/rules.md` di pesan yang membawanya. Isi rules tidak memenuhi gelembung chat, juga saat sesi lama diputar ulang.
- Membuat: menu `/` → *Rules proyek* (atau *Hermes: Buka Rules Proyek*) membuat file dari template (ID/EN) bila belum ada.
- Batas: 20 file, 16 KB total; kelebihannya dipotong dan chip diberi tanda ⚠.
- Hermes sendiri juga membaca `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, dan `.hermes.md` di proyek. Rules IDE adalah lapisan tambahan; jangan menulis hal yang sama di keduanya.
- Rules sampai ke model sebagai instruksi, jadi perlakukan seperti kode: tinjau file rules dari repositori orang lain sebelum mempercayainya (agent sendiri nonaktif di workspace yang belum tepercaya).

### Checkpoint dan "Kembalikan ke sini"

Sebelum agent mengubah file, isi file itu disimpan, per giliran chat (baik edit lewat diff review maupun yang diterapkan otomatis). Di bawah pesanmu muncul **↩ Kembalikan ke sini** bila pesan itu atau giliran sesudahnya mengubah file.

- Klik membuka konfirmasi dengan daftar persis apa yang akan terjadi: file yang dikembalikan, file buatan agent yang dihapus, file yang berubah sejak edit agent (perubahan itu akan hilang), dan file dengan perubahan belum disimpan di editor.
- **Pemulihan bisa diurungkan**: tombol *Urungkan* di notifikasi, menu `/`, atau *Hermes: Urungkan Pemulihan Terakhir*. Isi file sebelum ditimpa disimpan dulu, termasuk pekerjaan yang kamu tambahkan setelah edit agent. Jika penulisan gagal di tengah jalan, semuanya dikembalikan otomatis.
- Percakapan tidak diputar mundur. Agent diberi catatan bahwa file dikembalikan, supaya ia membaca ulang sebelum mengedit lagi.
- Disimpan di storage workspace VS Code, dengan isi yang sama disimpan sekali, dan dibersihkan setelah 30 hari tak dipakai.

**Yang tidak tercakup, dan IDE mengatakannya:** perubahan oleh **perintah terminal** (`sed -i`, `git checkout`, `npm install`, dan sebagainya) terjadi di luar langkah izin edit, jadi tidak bisa dikembalikan. Giliran yang menjalankan perintah diberi tanda ⚠ dan dialog konfirmasi memperingatkannya. File di luar workspace dan file di atas 5 MB dilaporkan tetapi tidak dikembalikan otomatis. Edit inline (Ctrl+K) memakai sesi sendiri; pakai Ctrl+Z. Untuk perlindungan penuh tetap gunakan git.

### Pemakaian token dan biaya

- Jumlah token **nyata**, dari laporan Hermes untuk setiap giliran (masuk, keluar, pikiran/reasoning, cache), bukan perkiraan. (Angka `↓ ~56 token` yang berjalan saat agent bekerja tetap perkiraan, karena belum ada laporan.)
- Chip `↑48k ↓3.1k · ≈$0.21` di bar sesi; klik untuk **laporan Markdown**: sesi ini, hari ini, 7 dan 30 hari terakhir, per profil endpoint dan model. Juga lewat menu `/` atau *Hermes: Tampilkan Pemakaian Token dan Biaya*.
- **Biaya dihitung dari harga yang kamu isi sendiri** di `hermes.pricing` (per 1 juta token). IDE tidak pernah menebak harga:

  ```json
  "hermes.pricing": { "claude-sonnet-4-5": { "input": 3, "output": 15, "cachedInput": 0.3 } }
  ```

  Model dicocokkan lewat id persis, id tanpa awalan provider (`anthropic/claude-x` cocok dengan `claude-x`), atau akhiran terpanjang. Model tanpa harga ditandai `—` di laporan dan chip diberi `+` (biaya adalah batas bawah). Token cache memakai `cachedInput` bila diisi. Token reasoning tidak ditagih dua kali. Simbol mata uang: `hermes.usage.currency`.
- Data disimpan lokal di state global VS Code (120 hari, 200 sesi terakhir). Tidak ada yang dikirim ke mana pun.

### Notifikasi

Saat agent selesai atau butuh izin sementara kamu mengerjakan hal lain: pesan di IDE dengan tombol *Buka panel*, ditambah notifikasi Windows (`hermes.notifications.native`).

- `hermes.notifications.mode`: `unfocused` (bawaan, hanya saat jendela di latar belakang), `always`, atau `off`.
- Giliran yang selesai hanya diberi tahu bila berlangsung minimal `hermes.notifications.minSeconds` (bawaan 10 dtk). Permintaan izin selalu diberi tahu. Menekan Stop tidak memicu notifikasi.
- Toast Windows memakai identitas aplikasi yang terdaftar (Hermes IDE untuk IDE mandiri, VS Code di VS Code); Windows hanya menampilkannya bila identitas itu punya shortcut Start Menu, yang dibuat kedua installer tersebut.

### Cara ini diuji (Fase 5)

| Tes | Yang dibuktikan |
| --- | --- |
| `npm test` | Rules (penggabungan, batas, hash, penyaringan saat replay), checkpoint (pulihkan, hapus file buatan agent, beberapa giliran, urungkan, perubahan oleh pengguna, di luar workspace, ukuran, persistensi, pembersihan), pemakaian (peta token, harga, biaya, ledger, laporan), notifikasi (aturan dan skrip toast valid di PowerShell), pemeliharaan Hermes (parsing `update --check`, perintah instal pinned dijalankan nyata terhadap server lokal, CLI palsu untuk update/timeout) |
| `npm run test:vscode` | Di extension host sungguhan dengan Hermes asli dan server model tiruan: rules sampai ke model sekali per perubahan; token dan biaya tercatat per sesi; "Kembalikan ke sini" untuk edit lewat diff review dan edit otomatis, termasuk undo dan catatan ke agent; giliran dengan perintah terminal ditandai; notifikasi selesai dan izin; alur update Hermes (konfirmasi, backup, stop, restart, penilaian versi) dengan CLI palsu |
| `ide\scripts\e2e-install.ps1 -HermesMarker` | Pada mesin ini: task *Install Hermes* di installer tidak jalan pada instalasi senyap biasa, jalan dengan `/INSTALLHERMES=1`, dan tidak pernah jalan saat update (memakai perintah pengganti yang hanya menulis marker, bukan installer Hermes sungguhan) |

Yang **tidak** diuji: menjalankan installer Hermes resmi dan `hermes update` sungguhan (keduanya mengubah instalasi Hermes yang dipakai); hanya mekanismenya yang diuji, dengan skrip dan CLI pengganti. Tampilan toast Windows tidak bisa dilihat dari tes otomatis (skripnya dijalankan tanpa error; tes `HERMES_TEST_TOAST=1` menampilkannya sekali).

### Batasan Fase 5

- Checkpoint tidak mencakup efek perintah terminal (lihat di atas).
- Pembaruan Hermes tidak bisa dipin ke versi yang dites lewat CLI Hermes; IDE hanya menjaga, mencadangkan, dan memeriksa.
- Biaya selalu perkiraan: bergantung pada harga yang kamu isi, dan pada anggapan bahwa token cache termasuk dalam token masuk (seperti yang dilaporkan penyedia bergaya OpenAI).
- Pemasangan Hermes dari panel dan installer hanya untuk Windows. Di macOS/Linux ikuti dokumentasi Hermes.
- Notifikasi native hanya Windows; di platform lain hanya pesan di dalam IDE.

## Keunggulan dibanding editor AI lain (Fase 6)

Lima hal yang dikerjakan di sini: mode lokal penuh, routing model otomatis dengan cadangan, panel memori Hermes, galeri skill, dan agen paralel di worktree git. Satu yang **tidak** dikerjakan: agen latar belakang di VPS (lihat *Yang tidak dibangun*).

### Mode lokal penuh

Nyalakan lewat menu `/` → *Mode lokal penuh*, ⚙ → *Mode lokal penuh*, atau setting `hermes.privacy.localOnly`. Tujuannya: kode dan prompt hanya ke komputer ini atau ke server yang kamu daftarkan sendiri (`hermes.privacy.allowedHosts`, mis. `vps.contoh.com` atau `*.contoh.com`). Kedua setting berskala *application*, jadi `.vscode/settings.json` sebuah proyek tidak bisa mematikannya.

Yang dilakukan IDE saat mode ini hidup:

- **Endpoint model diperiksa.** Loopback (`localhost`, `127.0.0.1`, `::1`) dan alamat jaringan privat (10.x, 172.16-31.x, 192.168.x, 100.64/10, nama tanpa titik atau berakhiran `.local/.lan/.internal`) diterima; yang lain harus ada di daftar. Bila endpoint model ada di internet, **agent tidak dijalankan** dan panel menyebut alamat penyebabnya. Pesan yang diketik tidak ditambahkan ke chat.
- **Model di daftar** yang disajikan dari internet (Anthropic, OpenRouter, dan sebagainya) dikunci di picker; memilihnya ditolak.
- **Tool jaringan Hermes diblokir** lewat hook `pre_tool_call` yang sama dengan izin terminal: `web_search`, `web_extract`, `vision_analyze`, dan `browser_*`. Model diberi tahu alasannya.
- **Fitur IDE ikut dimatikan** untuk endpoint jarak jauh: Tab autocomplete, index codebase, server MCP jarak jauh (tidak diteruskan ke Hermes), dan semua pemeriksaan pembaruan (IDE dan Hermes).
- **Config Hermes dipindai.** Endpoint yang dipakai Hermes sendiri tanpa kamu pilih (`auxiliary.*`, `fallback_providers`, `fallback_model`, `delegation`, `moa`) dinilai juga; yang menuju internet menghalangi agent. Nilai config tidak ditampilkan, hanya jalurnya.
- **Perintah terminal** yang tampak memakai jaringan (`curl https://...` ke alamat luar, `git push`, `npm install`, `pip install`, `docker pull`, `ssh`, dan sebagainya) selalu meminta izin, tidak bisa "selalu izinkan", dan kartunya menyebut alasannya.
- **Pemeriksaan privasi** (menu `/` → *Pemeriksaan privasi*) membuka laporan Markdown: untuk tiap tempat data bisa pergi, apa statusnya (aman, diblokir, perhatian) dan apa yang dilakukan IDE.

**Batas yang jujur.** Hermes tidak memberi cara untuk mengawasi lalu lintas jaringan prosesnya, jadi IDE tidak bisa *membuktikan* tidak ada yang keluar. Yang bisa dijamin adalah kebijakan di atas. Perintah terminal yang kamu setujui tetap bisa memakai jaringan; deteksinya heuristik (bisa meleset ke dua arah). Skill, plugin, dan server MCP lokal yang kamu pasang menjalankan kode mereka sendiri. Laporan privasi mengatakan semua ini.

### Routing model otomatis (dengan cadangan)

⚙ → *Routing model otomatis*, atau setting `hermes.routing.*`. Bawaannya mati. Kamu memilih tiga model dari daftar: **ringan**, **kuat**, dan **cadangan**.

- Aturan memilih tier (pertama yang cocok): mode Plan → kuat; folder atau `@codebase` atau lebih dari 4000 karakter kode terlampir → kuat; gambar → kuat; pesan lebih panjang dari `hermes.routing.lightMaxChars` (bawaan 280) → kuat; kata kerja berat (refactor, migrasi, arsitektur, debug, implementasi, seluruh, keamanan, ...) → kuat; selain itu ringan. Tier yang tidak punya model dibiarkan memakai model terpilih.
- **Setiap keputusan ditulis di chat beserta alasannya** ("Routing: qwen2.5-coder:7b (pertanyaan singkat)"). Memilih model sendiri di picker **menjeda routing untuk sesi itu** (sesi baru memulainya lagi).
- **Cadangan**: bila model gagal karena autentikasi, kuota, batas laju, atau galat server (401, 402, 403, 404, 408, 429, 5xx) dan Hermes mencatat bahwa ia menyerah, pesan yang sama dikirim **sekali** ke model cadangan, dengan catatan di chat. Model yang baru gagal dilewati 5 menit. Pengulangan **tidak dilakukan bila agent sudah menjalankan tool** pada giliran itu, supaya pekerjaannya tidak terulang.
- Memindah model membuat Hermes membangun ulang agent-nya, yang bisa memakan beberapa detik pada pindah pertama.
- Di mode lokal penuh, model yang diblokir tidak pernah dipilih routing.

**Model lain di endpoint kustom.** Server seperti Ollama atau vLLM biasanya melayani banyak model, sementara Hermes hanya mendaftar yang disebut profil. IDE membaca `GET {base}/models` dari endpoint itu dan menambahkan sisanya ke picker (dikirim ke Hermes sebagai `custom:<id>`, yang Hermes terima saat pindah model). Dengan begitu routing berguna juga di profil kustom.

### Panel memori

Tombol 🧰 di header → *Memori Hermes*. Hermes menyimpan dua berkas yang ia baca setiap sesi baru: `MEMORY.md` (catatan agent) dan `USER.md` (tentang kamu). Panel menampilkan tiap catatan, dan kamu bisa mengubah, menghapus, atau menambah.

- Formatnya persis milik Hermes (dibaca dari kodenya, `tools/memory_tool_store.py`): catatan dipisah `\n§\n`, dipangkas, tanpa catatan kosong, tanpa BOM. Format lain dianggap "drift" dan membuat Hermes menolak menulis memorinya sendiri, jadi IDE hanya menulis bentuk itu. Berkas yang bentuknya tidak rapi diberi peringatan sebelum ditimpa.
- Batas karakter dibaca dari `config.yaml` (`memory.memory_char_limit` / `user_char_limit`, bawaan 2200 dan 1375) dan ditampilkan sebagai pemakaian; menyimpan di atas batas ditolak. Berkas yang dimatikan di config diberi tanda.
- Menyimpan memeriksa bahwa berkas **tidak berubah sejak dimuat** (agent bisa menulis memori kapan saja); jika berubah, isi terbaru dimuat dan perubahanmu tidak ditimpa. Versi sebelumnya disimpan sebagai `.hermes-ide-bak`.
- Perubahan terlihat oleh **sesi yang dimulai sesudahnya** (Hermes membekukan memori saat sesi mulai); tombol *Mulai sesi baru* muncul setelah menyimpan.
- Folder yang dipakai: milik Hermes sendiri untuk profil *Konfigurasi Hermes*, atau folder IDE untuk profil kustom. Isi memori hanya dibaca saat kamu membuka panel dan tidak dikirim ke mana pun.

### Galeri skill

Tombol 🧰 → *Galeri skill*. Pembungkus tipis untuk `hermes skills`: daftar skill terpasang, pencarian di registry Hermes (`search --json`), pratinjau (`inspect`), pasang, dan copot.

- Hermes yang memegang registri, pemindaian keamanan, dan lokasi pasang; IDE tidak pernah memakai `--force`, jadi verdict yang diblokir pemindai tetap diblokir.
- **Memasang dan mencopot selalu meminta konfirmasi** dengan sumber dan tingkat kepercayaan yang dilaporkan Hermes. Skill memberi agent instruksi baru dan kadang skrip yang bisa dijalankan; pakai *Lihat* untuk membaca dulu bila sumbernya tak dikenal.
- Hanya skill dari galeri yang bisa dicopot di sini (bukan skill bawaan atau buatanmu).
- Pencarian dan pemasangan butuh internet, jadi dimatikan di mode lokal penuh (daftar yang terpasang tetap terlihat).
- Semua nilai yang masuk ke baris perintah (pengenal skill, nama, kata kunci) divalidasi ketat dulu; URL mentah tidak diterima.

### Agen paralel di worktree git

Tombol 🧰 → *Agen paralel*. Tulis tugas, mulai; tiap tugas menjadi **proses Hermes sendiri di worktree git sendiri** (cabang `hermes/task-<id>`, di folder IDE, di luar proyekmu). Beberapa tugas jalan bersamaan (`hermes.tasks.maxParallel`, bawaan 3) tanpa saling melihat dan tanpa menyentuh berkasmu.

- Mulai dari **commit terakhir** (`HEAD`); perubahan yang belum di-commit tidak ikut. Proyek harus berada di repositori git yang sudah punya commit.
- Tidak ada yang mengawasi tugas, jadi izinnya ketat (`src/core/taskPolicy.ts`): edit **di dalam worktree** otomatis diizinkan; edit di luar ditolak. Perintah terminal ditolak kecuali tugas dimulai dengan kotak *Boleh menjalankan perintah* **dan** perintahnya persis ada di daftar izin proyek ("selalu izinkan"), tidak berbahaya, dan (di mode lokal) tidak memakai jaringan. Semua jenis izin lain ditolak. Setiap penolakan dicatat dan terlihat di kartu tugas beserta alasannya.
- Karena itu tugas hanya bisa dimulai bila **hook persetujuan terminal aktif**; tanpa hook, perintah biasa tidak akan melewati kebijakan ini.
- Saat selesai (atau dihentikan, atau gagal), pekerjaannya di-commit di cabang tugas supaya tidak hilang. Kartu menampilkan berkas dan +/− baris, ringkasan agent, tombol *Lihat perubahan* (diff), *Percakapan*, *Buka folder*, **Terapkan ke proyek**, dan **Buang**.
- **Terapkan** memasukkan hasilnya sebagai perubahan yang *belum di-commit* di folder kerjamu (`git apply`, diperiksa dulu: bila ada yang bentrok dengan suntinganmu, **tidak ada yang diterapkan**, dan perubahan tetap ada di cabang tugas). **Buang** menghapus worktree dan cabangnya setelah konfirmasi.
- Daftar tugas disimpan per workspace. Tugas yang sedang berjalan saat IDE ditutup ditandai *terputus* (prosesnya sudah mati; worktree-nya masih bisa ditinjau atau dibuang). Percakapan tugas tidak disimpan lintas restart.

### Yang tidak dibangun

**Agen latar belakang di VPS** (poin keempat Fase 6) tidak dikerjakan. Dua alasan: PRD menyisakannya sebagai pertanyaan terbuka (VPS milik pengguna atau layanan hosted), dan `hermes serve` memakai protokol JSON-RPC/WebSocket sendiri yang tidak bisa saya uji di sini tanpa server. Fondasinya ada (agen paralel di worktree, kebijakan izin tanpa pengawas, daftar host milikmu di mode lokal), tetapi saya tidak mengklaim fitur itu ada.

### Cara ini diuji (Fase 6)

| Tes | Yang dibuktikan |
| --- | --- |
| `npm test` | Klasifikasi host dan model, penilaian privasi dan pemindaian config Hermes, deteksi perintah berjaringan, aturan routing, format dan batas memori (termasuk menolak menimpa berkas yang berubah), parser dan validasi skill, `hermes skills` dijalankan lewat CLI palsu termasuk jalur shim `.cmd`, daftar model endpoint, kebijakan izin tugas, dan git worktree nyata (buat, edit paralel, terapkan, bentrok, buang, tanpa identitas git) |
| `npm run test:vscode` | Di extension host dengan Hermes asli dan server model tiruan: tool jaringan diblokir hook dan alasannya sampai ke model; perintah berjaringan selalu meminta izin; endpoint jarak jauh menahan agent dan jalan kembali berfungsi; routing ringan/kuat, cadangan setelah 401 (dengan pesan di chat dan tanpa pesan ganda), model gagal dilewati, dan jeda manual; memori ditulis lewat panel lalu **terbaca di system prompt sesi baru**; galeri membaca daftar dari `hermes skills list` asli dan mati di mode lokal; dua agen paralel jalan bersamaan di worktree masing-masing, perintah ditolak, hasil diterapkan dan dibuang |

Yang **tidak** diuji, dan perlu kamu ketahui:

- **Mode lokal hanya diuji terhadap server tiruan di loopback**, bukan Ollama atau vLLM sungguhan (tidak terpasang di mesin ini). Klasifikasi host-nya diuji unit, tetapi perilaku Hermes dengan Ollama asli belum.
- **Pencarian dan pemasangan skill dari registry** tidak otomatis diuji (butuh internet dan konfirmasi dialog). Saya menjalankan `hermes skills search --json` dan `install` sungguhan sekali, ke folder Hermes sementara, untuk memastikan format keluarannya; yang diuji otomatis adalah penguraian dan argumen yang dikirim.
- Mode lokal tidak memeriksa lalu lintas jaringan, hanya menegakkan kebijakan (lihat batas di atas).
- Routing diuji dengan dua model di satu endpoint tiruan; perilaku dengan penyedia sungguhan (kode galat, retry bawaan Hermes yang bisa memperlambat cadangan) bergantung pada penyedia itu.

### Batasan Fase 6

- Cadangan routing baru berjalan setelah Hermes menyerah pada model itu; Hermes sendiri mencoba ulang beberapa kali dulu untuk galat sementara (429, 5xx), jadi cadangan bisa tertunda.
- Worktree berisi seluruh repositori (agen bekerja di sub-folder yang sama dengan proyekmu), dan worktree tidak membawa berkas yang di-ignore git (mis. `node_modules`); tugas yang butuh itu harus memasangnya sendiri, yang berarti perintah terminal.
- Tiap tugas adalah proses Hermes penuh dengan pemakaian model sendiri; sesuaikan `hermes.tasks.maxParallel`.
- Izin tugas membandingkan path tanpa mengikuti tautan simbolik.
- Memori yang dipindai Hermes untuk pola injeksi bisa tampil sebagai diblokir bagi agent walau terlihat di panel; panel menampilkan isi berkas apa adanya.

## Izin untuk setiap perintah terminal

Hermes sendiri hanya meminta izin untuk perintah yang ia anggap berisiko. Agar *setiap* perintah ditanya (tujuan PRD #4), Hermes IDE memasang hook `pre_tool_call` Hermes untuk tool `terminal` dan `execute_code`. Hook itu menjawab `{"action": "approve"}`, yang membuat Hermes meminta izin lewat ACP seperti biasa, sehingga kartu izin di panel muncul untuk setiap perintah.

- Hook hanya aktif bila Hermes dijalankan dari IDE (env `HERMES_IDE_TERMINAL_APPROVAL=1`). Hermes CLI tidak berubah.
- Profil kustom: hook dipasang otomatis di `HERMES_HOME` milik IDE.
- Profil Konfigurasi Hermes: hook baru ditambahkan ke config Hermes milikmu setelah kamu menekan **Aktifkan** di panel. Satu blok bertanda ditambahkan di akhir `config.yaml` tanpa mengubah baris lain, dan cadangan `config.yaml.hermes-ide-backup` dibuat lebih dulu. Hapus lewat *Hermes: Hapus Hook Izin Terminal dari Config Hermes*.
- Hook dijalankan dengan Node: `hermes.nodePath`, lalu Node di `PATH`, lalu Node bawaan Hermes. Matikan fitur ini dengan `hermes.terminal.askEveryCommand: false`.
- Untuk perintah berisiko Hermes bertanya dua kali (hook, lalu pengecekan bahayanya sendiri). Ekstensi menjawab permintaan kedua otomatis, jadi kamu cukup ditanya sekali.

## Batasan yang diketahui

- **Accept per hunk** bekerja dengan mengizinkan seluruh edit lalu mengembalikan hunk yang ditolak setelah Hermes menulis, karena ACP hanya bisa mengizinkan atau menolak satu edit utuh. Hermes diberi tahu lewat catatan di pesan berikutnya.
- Patch multi-file (format V4A) hanya bisa diterima atau ditolak utuh.
- Jika file punya perubahan yang belum disimpan, kartu edit memberi peringatan; menerima edit akan menimpanya.
- Hermes 0.21.x di Windows menerjemahkan URI `file:///C:/...` menjadi path WSL, sehingga lampiran `resource_link` tidak terbaca. Karena itu ekstensi menyematkan isi file sendiri.
- **Angka token di indikator adalah perkiraan** (sekitar 4 karakter per token dari teks dan pikiran yang sudah di-stream), karena ACP tidak mengirim jumlah token per jawaban. Angka pemakaian konteks di composer (`15.2k / 256k`) berasal dari Hermes.
- **Plan dan Ask bergantung pada instruksi di prompt.** Edit selalu tertahan karena selalu lewat permintaan izin. Perintah terminal hanya bisa ditolak bila Hermes meminta izin; tanpa hook izin terminal (lihat bagian di atas), sebagian perintah bisa berjalan tanpa ditanya.
- **Edit otomatis dan Auto melewati diff review** untuk edit di dalam workspace; **Super Auto** juga untuk edit di luar workspace. Edit yang sudah diterapkan dibatalkan lewat git atau undo editor. Checkpoint tidak memulihkan file di luar workspace.
- Gambar yang ditempel hanya berguna bila model yang dipakai Hermes bisa membaca gambar. Pesan berisi gambar saja tanpa teks belum bisa dikirim.
- Hermes tidak menyimpan sesi yang belum pernah menerima pesan. Sesi kosong tidak muncul di daftar dan tidak bisa dilanjutkan setelah restart (ekstensi membuat sesi baru).

## Pengembangan

```powershell
npm run build              # bundle ekstensi + webview ke dist/
npm run watch              # rebuild otomatis
npm run typecheck
npm test                   # unit test (vitest)
npm run test:integration   # hermes acp asli + server OpenAI tiruan lokal
npm run test:vscode        # ekstensi di VS Code sungguhan (membuka jendela VS Code sementara)
```

Tes integrasi dan tes VS Code tidak memakai endpoint atau API key sungguhan: model chat, FIM, dan embedding diganti server tiruan di `test/fixtures/openai-mock.mjs` (embedding tiruan berupa bag-of-words ter-hash), dan `test/fixtures/mcp-echo.mjs` adalah server MCP kecil untuk tes F-15.

Struktur:

- `src/core/`: logika tanpa dependensi VS Code (klien ACP, JSON-RPC, endpoint, profil, tes koneksi, hunk, kebijakan perintah, hook izin terminal, konteks, MCP, FIM, embedding, chunker, vector store, server MCP HTTP, transkrip, updater IDE).
- `src/vscode/`: integrasi VS Code (layanan Hermes, webview, diff review, sesi, edit inline, indeks file, profil, Tab autocomplete, index codebase, status bar, log, updater IDE).
- `src/shared/`: kontrak pesan host↔webview dan string UI (ID/EN).
- `webview/src/`: panel chat (React). `Transcript.tsx` (timeline dan indikator), `Composer.tsx` (input, chip, tempel gambar, menu), `ComposerMenus.tsx` (menu `/` dan mode), `ModelPicker.tsx`, `Sessions.tsx` (bar sesi dan riwayat), `SettingsCard.tsx` (⚙).
- `ide/`: IDE mandiri (Fase 4). `brand.json` (identitas, pin VSCodium, URL feed), `scripts/` (`build.mjs`, `lib.mjs` yang murni dan dites, `icons.mjs`, `smoke.mjs`, `publish-openvsx.mjs`, `e2e-install.ps1`), `installer/hermes-ide.iss` (Inno Setup), `assets/icon.svg`. Hasil build di `ide/out/`, cache unduhan di `ide/.cache/` (keduanya diabaikan git).
- Fase 5: `src/core/rules.ts`, `checkpoints.ts`, `usage.ts` + `usageReport.ts`, `notify.ts`, `hermesMaintenance.ts` (semua murni dan dites); `src/vscode/projectRules.ts`, `checkpointManager.ts`, `usageTracker.ts`, `notifier.ts`, `hermesMaintenance.ts`; `src/shared/hermesVersions.json` (rentang dan build Hermes yang dites, perintah instal; dibaca juga oleh skrip build installer) dan `presets.ts`; `webview/src/Onboarding.tsx`.
