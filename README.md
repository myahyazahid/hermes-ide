# Hermes IDE

Ekstensi VS Code yang menjalankan [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) lewat ACP (Agent Client Protocol), dengan endpoint model yang bisa kamu atur sendiri. Rancangan lengkapnya ada di [docs/hermes-ide_prd.md](docs/hermes-ide_prd.md). Status saat ini: **Fase 1 (MVP ekstensi)**.

## Syarat

- Hermes Agent 0.21.x terpasang (`hermes acp --check` harus OK).
- VS Code 1.95 atau lebih baru. Target utama Windows 10/11.
- Model dengan konteks minimal 64.000 token yang mendukung tool calling.

## Pasang

```powershell
npm install
npm run package          # menghasilkan hermes-ide-0.1.0.vsix
code --install-extension hermes-ide-0.1.0.vsix
```

Buka folder proyek, lalu klik ikon ✦ **Hermes Agent** di activity bar. Hermes dijalankan saat panel dibuka dan dihentikan saat VS Code ditutup.

## Endpoint: dua mode

| Mode | Cara kerja | Kapan dipakai |
| --- | --- | --- |
| **Konfigurasi Hermes** (default) | Memakai provider, base URL, dan key dari config Hermes milikmu (`%LOCALAPPDATA%\hermes\config.yaml`). Model bisa diganti per sesi dari dropdown di composer; pilihan terakhir diingat. | Hermes sudah diatur lewat `hermes model`. |
| **Custom API** | Hermes dijalankan dengan profil terpisah milik IDE (`HERMES_HOME` di storage ekstensi). Base URL dan model ditulis ke `config.yaml` profil itu; API key disimpan di SecretStorage VS Code dan hanya diteruskan lewat environment proses. | Mencoba endpoint lain (OpenRouter, vLLM, Ollama) tanpa mengubah config Hermes. |

Kenapa dua mode: Hermes membaca provider dan base URL dari `config.yaml` *sebelum* environment, jadi endpoint tidak bisa dialihkan lewat env saja. Profil Custom API punya riwayat sesi dan memori sendiri, terpisah dari Hermes CLI.

**Tes koneksi** (mode Custom API) memeriksa URL, key, model, dukungan tool calling, latensi, dan konteks (gagal bila < 64k). Di mode Konfigurasi Hermes, tes membuka sesi lewat Hermes tanpa mengirim prompt.

## Alur kerja

- **Chat**: Enter untuk kirim, Shift+Enter baris baru, Esc atau tombol Stop untuk menghentikan langkah agent.
- **Aktivitas tool**: setiap baca/edit/jalankan tampil dengan status, durasi, dan `+tambah -hapus`.
- **Edit file**: Hermes meminta izin sebelum menulis. Diff terbuka di editor; terima dengan **Ctrl+Enter**, tolak dengan **Ctrl+Backspace**, atau dari kartu di panel. Jika ada beberapa hunk, CodeLens di tiap hunk bisa menolak hunk tertentu.
- **Perintah terminal**: kartu izin dengan Izinkan / Izinkan selalu / Tolak. "Izinkan selalu" disimpan per workspace (perintah persis sama) dan bisa dihapus lewat *Hermes: Kelola Perintah Izinkan Selalu*. Perintah berisiko (hapus rekursif, `git push --force`, `git reset --hard`, pipe ke shell, dll.) selalu ditanya.
- **Keandalan**: jika proses Hermes mati, panel menampilkan tombol *Mulai ulang Hermes*; percakapan dilanjutkan lewat `session/load` tanpa reload jendela.
- **Log**: *Hermes: Tampilkan Agent Log* (stderr Hermes + log ekstensi), *Hermes: Ekspor Log* untuk debugging. API key disamarkan di log.

## Batasan yang diketahui

- **Hermes hanya meminta izin untuk perintah yang ia anggap berisiko.** Perintah biasa (`npm test`, `ls`) langsung dijalankan dan hanya tampil di kartu aktivitas. Ini belum memenuhi tujuan PRD "perintah terminal selalu butuh izin"; lihat catatan di bawah.
- **Accept per hunk** bekerja dengan mengizinkan seluruh edit lalu mengembalikan hunk yang ditolak setelah Hermes menulis, karena ACP hanya bisa mengizinkan atau menolak satu edit utuh. Hermes diberi tahu lewat catatan di pesan berikutnya.
- Patch multi-file (format V4A) hanya bisa diterima atau ditolak utuh.
- Jika file punya perubahan yang belum disimpan, kartu edit memberi peringatan; menerima edit akan menimpanya.

## Pengembangan

```powershell
npm run build              # bundle ekstensi + webview ke dist/
npm run watch              # rebuild otomatis
npm run typecheck
npm test                   # unit test (vitest)
npm run test:integration   # hermes acp asli + server OpenAI tiruan lokal
npm run test:vscode        # ekstensi di VS Code sungguhan (membuka jendela VS Code sementara)
```

Tes integrasi dan tes VS Code tidak memakai endpoint atau API key sungguhan: model diganti server tiruan di `test/fixtures/openai-mock.mjs`.

Struktur:

- `src/core/`: logika tanpa dependensi VS Code (klien ACP, JSON-RPC, endpoint, tes koneksi, hunk, kebijakan perintah, transkrip).
- `src/vscode/`: integrasi VS Code (layanan Hermes, webview, diff review, status bar, log).
- `src/shared/`: kontrak pesan host↔webview dan string UI (ID/EN).
- `webview/src/`: panel chat (React).
