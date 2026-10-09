# Hermes IDE

Ekstensi VS Code yang menjalankan [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) lewat ACP (Agent Client Protocol), dengan endpoint model yang bisa kamu atur sendiri. Rancangan lengkapnya ada di [docs/hermes-ide_prd.md](docs/hermes-ide_prd.md). Status saat ini: **Fase 2 (pengalaman ala Cursor)**.

## Syarat

- Hermes Agent 0.21.x terpasang (`hermes acp --check` harus OK).
- VS Code 1.95 atau lebih baru. Target utama Windows 10/11.
- Model dengan konteks minimal 64.000 token yang mendukung tool calling.

## Pasang

```powershell
npm install
npm run package          # menghasilkan hermes-ide-0.2.0.vsix
code --install-extension hermes-ide-0.2.0.vsix
```

Buka folder proyek, lalu klik ikon ✦ **Hermes Agent** di activity bar. Hermes dijalankan saat panel dibuka dan dihentikan saat VS Code ditutup.

## Profil endpoint

| Profil | Cara kerja | Kapan dipakai |
| --- | --- | --- |
| **Konfigurasi Hermes** (bawaan) | Memakai provider, base URL, dan key dari config Hermes milikmu (`%LOCALAPPDATA%\hermes\config.yaml`). Model bisa diganti per sesi dari dropdown di composer; pilihan terakhir diingat. | Hermes sudah diatur lewat `hermes model`. |
| **Profil kustom** (bisa banyak, misal "VPS vLLM", "OpenRouter") | Hermes dijalankan dengan `HERMES_HOME` milik IDE. Base URL dan model profil aktif ditulis ke `config.yaml` di sana; API key tiap profil disimpan terpisah di SecretStorage VS Code, dan hanya key profil aktif yang diteruskan lewat environment. | Mencoba endpoint lain tanpa mengubah config Hermes. |

Ganti profil dari kartu Custom API atau dengan mengklik nama model di status bar.

Kenapa profil kustom butuh `HERMES_HOME` sendiri: Hermes membaca provider dan base URL dari `config.yaml` *sebelum* environment, jadi endpoint tidak bisa dialihkan lewat env saja. Profil kustom punya riwayat sesi dan memori sendiri, terpisah dari Hermes CLI. Endpoint dari Fase 1 (`hermes.endpoint.*`) otomatis dipindahkan menjadi profil "Custom API".

**Tes koneksi** (profil kustom) memeriksa URL, key, model, dukungan tool calling, latensi, dan konteks (gagal bila < 64k). Di profil Konfigurasi Hermes, tes membuka sesi lewat Hermes tanpa mengirim prompt.

## Alur kerja

- **Chat**: Enter untuk kirim, Shift+Enter baris baru, Esc atau tombol Stop untuk menghentikan langkah agent.
- **Konteks**: ketik `@` di composer untuk memilih file atau folder. Seleksi editor ditambahkan dengan **Ctrl+Alt+L** atau klik kanan → *Tambahkan Seleksi ke Chat*; file/folder di Explorer lewat klik kanan → *Tambahkan ke Chat Hermes*. Isi file disematkan langsung ke prompt (maks 200 KB per file).
- **Aktivitas tool**: setiap baca/edit/jalankan tampil dengan status, durasi, dan `+tambah -hapus`.
- **Edit file**: Hermes meminta izin sebelum menulis. Diff terbuka di editor; terima dengan **Ctrl+Enter**, tolak dengan **Ctrl+Backspace**, atau dari kartu di panel. Jika ada beberapa hunk, CodeLens di tiap hunk bisa menolak hunk tertentu.
- **Edit inline**: pilih kode, tekan **Ctrl+K**, tulis instruksi. Hermes mengerjakannya di sesi terpisah (riwayat chat tetap bersih), dan hasilnya tampil sebagai diff di grup editor yang sama. Ctrl+K dengan seleksi menggantikan chord Ctrl+K bawaan VS Code; matikan lewat `hermes.inlineEdit.useCtrlK` bila perlu.
- **Sesi agent**: panel *Sesi Agent* di Explorer menampilkan riwayat sesi workspace ini. Klik untuk melanjutkan (riwayat diputar ulang di panel), ikon tempat sampah untuk menghapus (lewat `hermes sessions delete`).
- **Server MCP**: tambahkan di bagian *Server MCP* pada kartu Custom API (stdio: perintah + argumen; http/sse: URL). Server diteruskan ke Hermes lewat ACP hanya untuk sesi IDE; config Hermes tidak diubah. Hermes menaruh tool MCP di balik `tool_search`, jadi model memanggilnya lewat `tool_call`.
- **Perintah terminal**: kartu izin dengan Izinkan / Izinkan selalu / Tolak untuk **setiap perintah** (lihat bagian berikut). "Izinkan selalu" disimpan per workspace (perintah persis sama) dan bisa dihapus lewat *Hermes: Kelola Perintah Izinkan Selalu*. Perintah berisiko (hapus rekursif, `git push --force`, `git reset --hard`, pipe ke shell, dll.) selalu ditanya.
- **Keandalan**: jika proses Hermes mati, panel menampilkan tombol *Mulai ulang Hermes*; percakapan dilanjutkan lewat `session/load` tanpa reload jendela.
- **Log**: *Hermes: Tampilkan Agent Log* (stderr Hermes + log ekstensi), *Hermes: Ekspor Log* untuk debugging. API key disamarkan di log.

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

Tes integrasi dan tes VS Code tidak memakai endpoint atau API key sungguhan: model diganti server tiruan di `test/fixtures/openai-mock.mjs`, dan `test/fixtures/mcp-echo.mjs` adalah server MCP kecil untuk tes F-15.

Struktur:

- `src/core/`: logika tanpa dependensi VS Code (klien ACP, JSON-RPC, endpoint, profil, tes koneksi, hunk, kebijakan perintah, hook izin terminal, konteks, MCP, transkrip).
- `src/vscode/`: integrasi VS Code (layanan Hermes, webview, diff review, sesi, edit inline, indeks file, profil, status bar, log).
- `src/shared/`: kontrak pesan host↔webview dan string UI (ID/EN).
- `webview/src/`: panel chat (React).
