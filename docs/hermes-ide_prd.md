# PRD Hermes IDE

Oct 9, 2026 · @yahya

## Ringkasan

Hermes IDE adalah code editor bergaya Cursor yang memakai Hermes Agent (Nous Research) sebagai otak agent-nya, dengan API model yang bisa diatur sendiri. Kita tidak membangun agent dari nol: Hermes sudah menyediakan loop agent, tool, memori, dan mode server ACP (Agent Client Protocol). Produk ini membangun lapisan editor di atasnya.

Versi pertama dikirim sebagai **ekstensi VS Code** yang menjalankan `hermes acp` sebagai proses anak. Setelah ekstensinya matang, ekstensi itu dibundel ke fork VSCodium dengan branding sendiri, sehingga jadi IDE mandiri tanpa menulis ulang kode.

**Untuk siapa:** developer yang ingin pengalaman agent ala Cursor tetapi bebas memilih model dan endpoint, termasuk model self-hosted (vLLM, Ollama) atau provider murah, tanpa terkunci ke langganan satu vendor.

## Latar belakang & masalah

Editor AI yang ada memaksa pilihan antara kenyamanan dan kebebasan. Cursor nyaman, tetapi model dan harga ditentukan vendor. Sebaliknya, menjalankan agent open-source lewat CLI memberi kebebasan, tetapi alur kerjanya jauh dari editor.

Masalah yang ingin diselesaikan:

- **Vendor lock-in model.** Developer tidak bisa memakai endpoint sendiri (self-hosted, OpenRouter, provider lokal) untuk fitur agent secara penuh.
- **Agent CLI terpisah dari editor.** Hermes sudah kuat di terminal, tetapi diff, konteks file, dan izin perintah tidak tampil di tempat developer bekerja.
- **Membangun agent itu mahal.** Loop agent, tool use, memori, dan MCP butuh waktu berbulan-bulan; Hermes sudah menyediakannya.

Kesempatannya: Hermes punya mode ACP yang dirancang agar editor bisa menampilkan chat, aktivitas tool, diff file, dan perintah terminal. Yang belum ada adalah klien editor yang rapi dan fokus untuk Hermes.

## Tujuan, non-tujuan, dan metrik keberhasilan

Tujuan utama: developer bisa menyelesaikan tugas coding multi-file dengan Hermes dari dalam editor, memakai endpoint pilihannya sendiri.

**Tujuan**

1. Hermes Agent berjalan di dalam editor lewat ACP, tanpa membuka terminal terpisah.
2. Base URL, API key, dan model bisa diganti dari UI, dan koneksinya bisa dites sebelum dipakai.
3. Setiap perubahan file dari agent tampil sebagai diff yang bisa di-accept atau reject.
4. Perintah terminal dari agent selalu butuh izin, kecuali pengguna memilih "izinkan selalu".

**Non-tujuan (versi 1)**

- Membangun atau memodifikasi framework agent Hermes.
- Melatih atau meng-hosting model sendiri.
- Autocomplete inline (Tab) dan codebase indexing; dijadwalkan di Fase 3.
- Fork VS Code dengan perubahan kode inti.
- Kolaborasi multi-user dan sinkronisasi cloud.

**Metrik keberhasilan (target, bisa disesuaikan)**

| Metrik | Target | Cara ukur |
| --- | --- | --- |
| Waktu dari install sampai pesan pertama terjawab | < 5 menit | Uji coba dengan pengguna baru |
| Waktu sampai token pertama tampil di panel | < 1 dtk di atas latensi model | Log ekstensi |
| Edit agent yang di-accept tanpa diubah | ≥ 60% | Hitung accept vs reject |
| Sesi yang crash atau kehilangan koneksi ACP | < 2% | Log ekstensi |
| Endpoint OpenAI-compatible yang lolos uji koneksi | OpenRouter, Ollama, vLLM | Matriks uji manual |

## Persona & user stories

| Persona | Kebutuhan utama | Kendala sekarang |
| --- | --- | --- |
| Developer full-stack mandiri (misal Laravel + Tailwind) | Agent yang bisa mengedit banyak file dan menjalankan perintah proyek | Biaya langganan dan model yang tidak bisa dipilih |
| Developer yang self-host model | Memakai vLLM atau Ollama di VPS sendiri untuk agent | Editor AI populer tidak mendukung endpoint sendiri secara penuh |
| Pengguna Hermes CLI | Pengalaman Hermes yang sama, tapi di dalam editor | Diff dan konteks file harus dilihat manual |

**User stories**

1. Sebagai developer, saya ingin mengisi base URL, API key, dan model lalu menekan "Tes koneksi", supaya saya yakin endpoint saya bekerja sebelum mulai.
2. Sebagai developer, saya ingin menyebut file dengan `@nama-file` di chat, supaya agent memakai konteks yang tepat.
3. Sebagai developer, saya ingin melihat setiap edit agent sebagai diff dan memilih accept atau reject per file atau per hunk.
4. Sebagai developer, saya ingin agent meminta izin sebelum menjalankan perintah terminal, dengan opsi "izinkan selalu" per perintah.
5. Sebagai developer, saya ingin melihat langkah agent (membaca, mengedit, menjalankan) secara live, supaya saya bisa menghentikannya kapan saja.
6. Sebagai developer, saya ingin melanjutkan sesi agent sebelumnya dari daftar riwayat.
7. Sebagai developer, saya ingin memilih teks lalu menekan Ctrl+K untuk memberi instruksi edit di tempat (Fase 2).

## Ruang lingkup per fase

Setiap fase menghasilkan sesuatu yang sudah bisa dipakai; fase berikutnya baru dimulai setelah kriteria selesai fase sebelumnya terpenuhi.

| Fase | Isi | Kriteria selesai |
| --- | --- | --- |
| 0 · Validasi | Install Hermes, atur endpoint kustom lewat `hermes model`, jalankan `hermes acp` manual | Hermes menjawab lewat endpoint kustom dan mode ACP aktif |
| 1 · MVP ekstensi | Klien ACP, panel chat streaming, aktivitas tool, izin perintah, diff accept/reject, halaman Custom API, binding cwd ke workspace | Tugas edit multi-file selesai dari panel, dites di Windows |
| 2 · Pengalaman ala Cursor | `@file` / `@folder` / seleksi, inline edit Ctrl+K, riwayat dan resume sesi, pengaturan MCP dari UI | 5 user story pertama lolos uji pengguna |
| 3 · Fitur di luar Hermes | Tab autocomplete via model FIM terpisah, codebase indexing (embedding + pencarian) | Saran Tab tampil < 500 ms di proyek uji |
| 4 · IDE mandiri (opsional) | Bundel ke VSCodium, branding, Open VSX, installer dan auto-update | Installer Windows terpasang dan update berjalan |

## Kebutuhan fungsional

Prioritas: P0 wajib di MVP (Fase 1), P1 di Fase 2, P2 di Fase 3 atau lebih.

| ID | Kebutuhan | Prioritas |
| --- | --- | --- |
| F-01 | Ekstensi menjalankan `hermes acp` sebagai proses anak saat panel dibuka, dan menghentikannya saat VS Code ditutup | P0 |
| F-02 | Komunikasi JSON-RPC lewat stdio; stderr Hermes diteruskan ke tab "Agent Log" | P0 |
| F-03 | Workspace aktif dikirim sebagai cwd sesi, sehingga tool file dan terminal berjalan di proyek yang benar | P0 |
| F-04 | Halaman Custom API: base URL, API key, model; tombol "Tes koneksi" yang menampilkan latensi dan status tool use | P0 |
| F-05 | API key disimpan di SecretStorage VS Code dan diteruskan ke Hermes lewat environment, bukan ditulis ke file proyek | P0 |
| F-06 | Panel chat dengan streaming teks, markdown, dan blok kode | P0 |
| F-07 | Kartu aktivitas tool: membaca, mengedit, menjalankan, dengan status dan durasi | P0 |
| F-08 | Permintaan izin untuk perintah terminal: Izinkan, Izinkan selalu, Tolak | P0 |
| F-09 | Edit file tampil sebagai diff di editor; accept/reject per file dan per hunk; Ctrl+Enter dan Ctrl+Backspace | P0 |
| F-10 | Tombol Stop untuk menghentikan langkah agent yang sedang berjalan | P0 |
| F-11 | Status bar menampilkan status koneksi ACP dan model aktif | P0 |
| F-12 | Referensi konteks `@file`, `@folder`, dan teks terseleksi sebagai chip di composer | P1 |
| F-13 | Inline edit: pilih kode, Ctrl+K, tulis instruksi, hasil tampil sebagai diff di tempat | P1 |
| F-14 | Daftar sesi: buat, lanjutkan, dan hapus sesi agent | P1 |
| F-15 | Pengaturan server MCP dari UI, diteruskan ke Hermes | P1 |
| F-16 | Beberapa profil endpoint (misal "VPS vLLM", "OpenRouter") yang bisa diganti cepat | P1 |
| F-17 | Tab autocomplete lewat endpoint FIM terpisah yang juga bisa dikustom | P2 |
| F-18 | Codebase indexing: embedding file proyek dan pencarian semantik sebagai konteks | P2 |

## Kebutuhan non-fungsional

| Aspek | Kebutuhan |
| --- | --- |
| Platform | Windows 10/11 sebagai target utama; macOS dan Linux menyusul |
| Kompatibilitas | VS Code dan VSCodium versi stabil terbaru; Node sesuai VS Code |
| Performa | Panel terbuka < 1 dtk; UI tetap responsif saat agent menulis banyak file |
| Keandalan | Jika proses Hermes mati, ekstensi menampilkan status dan menawarkan restart tanpa reload jendela |
| Model | Model harus punya konteks minimal 64.000 token, sesuai syarat Hermes; ekstensi memperingatkan jika tidak |
| Aksesibilitas | Semua aksi panel bisa diakses lewat keyboard; kontras teks memenuhi WCAG AA |
| Bahasa | UI dalam bahasa Indonesia dan Inggris |
| Observability | Log ekstensi dan log Hermes bisa diekspor untuk debugging; tanpa telemetry ke server pihak ketiga secara default |

## Arsitektur teknis & integrasi Hermes ACP

Ekstensi tidak pernah memanggil model langsung. Ia menjalankan `hermes acp` dan berbicara lewat ACP; Hermes yang memilih provider, menjalankan tool, dan memanggil endpoint.

&#91;embedded content: arsitektur · ekstensi, proses Hermes, layanan luar\]

Kotak bergaris putus-putus adalah bagian yang kita bangun; sisanya sudah disediakan Hermes atau pihak luar. API key dari Halaman Custom API diteruskan ke Hermes lewat environment saat proses dijalankan.

**Stack**

- Ekstensi: TypeScript, VS Code Extension API, Webview (React atau Svelte) untuk panel chat.
- Komunikasi: JSON-RPC 2.0 lewat stdin/stdout; Hermes menulis log ke stderr sehingga stdout bersih untuk ACP.
- Diff: `vscode.diff` dan WorkspaceEdit untuk accept/reject per hunk.
- Konfigurasi Hermes: `~/.hermes/config.yaml` untuk default, environment untuk key per sesi.
- Fase 3: endpoint FIM terpisah untuk Tab, dan vector store lokal (misal SQLite + embedding) untuk indexing.

## UX & alur utama

Tata letak mengikuti mockup Dream IDE: explorer dan daftar sesi di kiri, editor dengan diff di tengah, terminal di bawah, panel Hermes Agent di kanan.

**Alur pertama kali**

1. Pengguna membuka panel Hermes. Ekstensi memeriksa apakah perintah `hermes` tersedia; jika tidak, tampil petunjuk instalasi.
2. Kartu Custom API meminta base URL, API key, dan model, lalu menjalankan tes koneksi.
3. Setelah lolos, ekstensi menjalankan `hermes acp` dan status bar berubah menjadi "Hermes · ACP".

**Alur tugas harian**

1. Pengguna menulis instruksi, menambahkan `@file` bila perlu, lalu mengirim.
2. Hermes membalas secara streaming; setiap langkah tool tampil sebagai baris di kartu aktivitas.
3. Perubahan file muncul sebagai diff di editor dengan bar Accept / Reject melayang.
4. Jika agent ingin menjalankan perintah, kartu izin kuning muncul di panel dan proses menunggu jawaban.
5. Pengguna meninjau hasil, lalu melanjutkan percakapan atau membuka sesi baru.

**Keadaan kosong dan error**

- Hermes belum terpasang: petunjuk instalasi dan tombol "Cek lagi".
- Tes koneksi gagal: pesan sesuai penyebab (URL salah, key ditolak, model tidak ditemukan, konteks < 64k).
- Proses ACP mati: banner di panel dengan tombol "Mulai ulang Hermes".

## Keamanan & privasi

Prinsipnya: agent tidak boleh mengubah apa pun di luar workspace atau menjalankan perintah tanpa sepengetahuan pengguna.

- **API key** disimpan di SecretStorage VS Code (Credential Manager di Windows), tidak pernah ditulis ke `settings.json` atau file proyek, dan disamarkan di UI.
- **Kebocoran key ke endpoint lain** dicegah dengan meneruskan hanya key milik profil aktif ke proses Hermes.
- **Perintah terminal** selalu melalui kartu izin. Daftar "izinkan selalu" disimpan per workspace dan bisa dihapus dari pengaturan.
- **Batas file**: tool file dan terminal berjalan relatif ke cwd workspace; edit di luar workspace ditolak atau butuh izin eksplisit.
- **Perintah berbahaya** (misal hapus rekursif, `git push --force`) selalu ditanya, meskipun ada di daftar "izinkan selalu".
- **Data kode** hanya dikirim ke endpoint yang dipilih pengguna; ekstensi tidak mengirim kode atau prompt ke server lain.
- **Workspace tidak tepercaya**: agent dinonaktifkan sampai pengguna menandai workspace sebagai tepercaya (Workspace Trust VS Code).

## Risiko, asumsi, dan pertanyaan terbuka

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Protokol ACP atau mode ACP Hermes berubah | Klien rusak setelah update Hermes | Kunci versi Hermes yang didukung; lapisan adapter ACP terpisah; tes integrasi tiap rilis |
| Model di endpoint kustom lemah dalam tool use | Agent gagal mengedit atau berputar-putar | Tes koneksi memeriksa tool use; daftar model yang direkomendasikan |
| Fitur ACP Hermes di Windows kurang matang | Target utama terganggu | Validasi di Fase 0; siapkan opsi WSL bila perlu |
| Ruang lingkup melebar ke fork terlalu cepat | Waktu habis untuk build dan merge upstream | Fork hanya di Fase 4, tanpa ubah kode inti |
| Pengembang tunggal, waktu terbagi dengan studi dan proyek lain | Jadwal molor | Fase kecil yang tiap akhirnya bisa dipakai |

**Asumsi**

- Hermes Agent tetap open-source dan mode ACP-nya tetap tersedia.
- Endpoint pengguna kompatibel dengan format OpenAI dan mendukung tool calling.
- Target pengguna awal adalah pemilik proyek sendiri, lalu developer lain.

**Pertanyaan terbuka**

- [ ] Nama produk final: "Hermes IDE" atau nama lain di bawah brand sendiri?
- [ ] Konfigurasi endpoint ditulis ke `~/.hermes/config.yaml` atau hanya lewat environment per sesi?
- [ ] Apakah ekstensi perlu mendukung editor ACP lain, atau fokus VS Code saja?
- [ ] Lisensi proyek: open-source (MIT/Apache) atau tertutup?

## Timeline & milestone

Urutan fase sudah tetap; tanggal target belum ditentukan dan diisi pemilik proyek. Setiap gate harus lolos sebelum fase berikutnya dimulai.

&#91;embedded content: roadmap · 5 fase, 4 gate\]

Belah ketupat di bawah garis batas fase adalah gate, dengan kriteria lolosnya di bawahnya. Fase 4 bergaris putus-putus karena opsional.

**Milestone berikutnya**

- [ ] Install Hermes Agent dan atur endpoint kustom
- [ ] Jalankan `hermes acp` dan pastikan berjalan di Windows
- [ ] Scaffold ekstensi TypeScript dengan klien ACP minimal
- [ ] Panel chat menampilkan balasan streaming pertama
- [ ] Tentukan tanggal target untuk Fase 1

## Setelah IDE mandiri: Fase 5–7

Setelah IDE mandiri jadi, tiga fase berikutnya membuatnya nyaman dipakai harian, lalu unggul di hal yang tidak bisa dilakukan Cursor: bebas model, bisa jalan lokal, dan agent yang ingat proyekmu.

### Fase 5 · Nyaman dipakai harian

Tujuannya: pengguna baru bisa produktif tanpa membaca dokumentasi, dan pengguna lama tidak takut agent merusak proyek.

| Fitur | Kenapa penting |
| --- | --- |
| Onboarding otomatis: installer IDE sekaligus memasang Hermes dan menjalankan wizard endpoint | Pengguna tidak perlu membuka terminal untuk mulai |
| Checkpoint per langkah agent, dengan tombol "kembalikan ke sini" | Eksperimen aman; kesalahan agent bisa dibatalkan dalam sekali klik |
| Rules per proyek (misal file `.hermes/rules.md`) yang otomatis masuk konteks | Agent mengikuti gaya kode dan konvensi proyek tanpa diulang tiap prompt |
| Pelacak token dan biaya per sesi dan per profil endpoint | Pengguna tahu berapa biaya tiap tugas, keunggulan nyata bagi yang memakai API berbayar |
| Notifikasi saat agent selesai atau butuh izin | Pengguna bisa mengerjakan hal lain selama agent bekerja |
| Auto-update IDE dan Hermes, dengan versi Hermes yang sudah dites | Update tidak merusak integrasi ACP |

**Kriteria selesai:** pengguna baru menyelesaikan tugas pertama < 10 menit tanpa bantuan; tidak ada laporan file rusak yang tidak bisa dikembalikan.

### Fase 6 · Keunggulan dibanding editor AI lain

Tujuannya: alasan jelas untuk memilih IDE ini, bukan sekadar "Cursor versi gratis".

| Fitur | Keunggulan |
| --- | --- |
| Routing model otomatis: model murah untuk tugas ringan, model kuat untuk tugas berat, fallback jika endpoint mati | Biaya lebih hemat tanpa memilih model manual |
| Mode lokal penuh dengan Ollama atau vLLM, tanpa kode keluar dari komputer atau server sendiri | Cocok untuk kode klien dan perusahaan yang ketat soal privasi |
| Panel memori proyek: melihat dan mengedit apa yang diingat Hermes lintas sesi | Agent makin paham proyek seiring waktu, dan pengguna tetap memegang kendali |
| Agent latar belakang di server: Hermes berjalan di VPS, tugas lanjut meski laptop ditutup | Tugas panjang (refactor, migrasi) tidak terikat ke laptop |
| Beberapa agent paralel, masing-masing di git worktree sendiri | Beberapa fitur dikerjakan bersamaan, lalu dipilih hasil terbaik |
| Galeri skill dan plugin Hermes yang bisa dipasang dari dalam IDE | Kemampuan agent bertambah tanpa menunggu update IDE |

**Kriteria selesai:** minimal satu keunggulan dipakai rutin oleh pengguna uji, misalnya mode lokal atau agent latar belakang.

### Fase 7 · Menarik untuk pasar lokal

Tujuannya: IDE ini terasa dibuat untuk developer Indonesia dan mudah direkomendasikan.

| Fitur | Kenapa menarik |
| --- | --- |
| UI, onboarding, dan respons agent dalam bahasa Indonesia secara default | Lebih mudah untuk pemula, mahasiswa, dan tim lokal |
| Template proyek siap pakai untuk stack populer (Laravel, Filament, Flutter, Next.js) dengan rules bawaan | Agent langsung paham konvensi framework sejak file pertama |
| Mode belajar: agent menjelaskan setiap perubahan dan alasannya | Menarik bagi mahasiswa dan bootcamp, bukan hanya developer senior |
| Deploy ke VPS lewat SSH dari panel agent, dengan izin per perintah | Alur dari coding sampai produksi ada di satu tempat |
| Profil endpoint siap pakai untuk provider yang terjangkau dari Indonesia | Setup lebih cepat, biaya lebih mudah diprediksi |

**Kriteria selesai:** dipakai oleh komunitas atau kelas pertama di luar pengembang sendiri, dengan feedback yang dikumpulkan.

**Pertanyaan terbuka untuk Fase 5–7**

- [ ] Apakah agent latar belakang memakai VPS milik pengguna, atau layanan hosted yang dikelola sendiri?
- [ ] Apakah fitur Fase 6–7 gratis semua, atau sebagian jadi versi berbayar?
