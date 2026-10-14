// Rules packs and stack detection for the project templates (phase 7). A pack is an ordinary `.hermes/rules/<stack>.md`
// file: the project owns it from the moment it is written, edits it freely, and the rules loader (phase 5) sends it to the
// agent like any other rules file. The packs stick to conventions that hold across versions and tell the agent to check
// the installed version first; they are a starting point for the team to edit, not a framework reference.
import type { Locale } from "../shared/strings";
import type { StackId } from "../shared/stacks";
import { RULES_DIR } from "./rules";

/** Workspace-relative path (forward slashes) of a stack's rules file. */
export const stackRulesPath = (id: StackId): string => `${RULES_DIR}/${id}.md`;

export interface ProjectProbe {
  has(relativePath: string): boolean;
  read(relativePath: string): string | undefined;
}

function jsonKeys(text: string | undefined, sections: readonly string[]): Set<string> {
  const keys = new Set<string>();
  if (!text) return keys;
  try {
    const doc = JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
    for (const section of sections) {
      const block = doc[section];
      if (block && typeof block === "object" && !Array.isArray(block)) for (const k of Object.keys(block)) keys.add(k);
    }
  } catch {
    // not valid JSON: treated as having no dependencies
  }
  return keys;
}

/** Which of the supported stacks the project looks like. Filament implies Laravel, and both are reported. */
export function detectStacks(probe: ProjectProbe): StackId[] {
  const found: StackId[] = [];
  const composer = jsonKeys(probe.read("composer.json"), ["require", "require-dev"]);
  const laravel = composer.has("laravel/framework") || (probe.has("artisan") && probe.has("composer.json"));
  if (laravel) found.push("laravel");
  if (composer.has("filament/filament")) found.push("filament");
  if (/^\s*sdk:\s*flutter\s*$/m.test(probe.read("pubspec.yaml") ?? "")) found.push("flutter");
  if (jsonKeys(probe.read("package.json"), ["dependencies", "devDependencies"]).has("next")) found.push("nextjs");
  return found;
}

const RULES: Record<StackId, Record<Locale, string>> = {
  laravel: {
    id: `# Konvensi Laravel

Panduan untuk agent di proyek Laravel ini. Periksa dulu versi \`laravel/framework\` dan PHP di \`composer.json\`, lalu ikuti struktur versi itu; jangan mencampur gaya versi lama dan baru. Sunting berkas ini sesuai kebiasaan tim.

## Cara bekerja
- Pakai generator Artisan (\`php artisan make:model -mfc\`, \`make:request\`, \`make:policy\`, \`make:test\`) alih-alih menulis kerangka dari nol.
- Lihat \`composer.json\` (scripts), \`package.json\`, dan README untuk cara menjalankan tes dan build sebelum menebaknya.
- Jalankan tes yang relevan (\`php artisan test\`, atau \`vendor/bin/pest\` / \`vendor/bin/phpunit\` sesuai proyek) sebelum menyatakan selesai.
- Ikuti gaya kode yang ada; bila proyek memakai Laravel Pint (\`vendor/bin/pint\`), jalankan pada berkas yang kamu ubah.

## Kode
- Validasi di Form Request, otorisasi di Policy atau Gate; controller tetap tipis.
- Logika bisnis di Action, Service, atau model, mengikuti pola yang sudah dipakai proyek.
- Eloquent: definisikan relasi, \`$fillable\` (atau guarded), dan \`casts\`; cegah N+1 dengan \`with()\`; hindari query mentah kecuali perlu, dan selalu pakai binding parameter.
- Respons JSON lewat API Resource; pekerjaan lambat lewat Job dan queue.
- Di kode aplikasi pakai \`config()\`; \`env()\` hanya di berkas \`config/\`.

## Database dan data
- Jangan mengubah migrasi yang sudah dijalankan di lingkungan lain; buat migrasi baru.
- Jangan menjalankan \`migrate:fresh\`, \`migrate:reset\`, \`db:wipe\`, atau seeder pada database yang bukan milik lokal tanpa persetujuan eksplisit pengguna.
- Beri factory dan seeder untuk model baru bila proyek memakainya.

## Keamanan
- Jangan menaruh rahasia di kode atau di berkas yang masuk git; \`.env\` tidak di-commit.
- Untuk data dari pengguna di Blade pakai \`{{ }}\`, bukan \`{!! !!}\`.
- Pastikan rute yang mengubah data dilindungi autentikasi dan CSRF (atau autentikasi API yang sesuai).
`,
    en: `# Laravel conventions

Guidance for the agent in this Laravel project. First check the \`laravel/framework\` and PHP versions in \`composer.json\` and follow that version's structure; do not mix old and new styles. Edit this file to match the team's habits.

## How to work
- Use the Artisan generators (\`php artisan make:model -mfc\`, \`make:request\`, \`make:policy\`, \`make:test\`) instead of writing boilerplate from scratch.
- Look at \`composer.json\` (scripts), \`package.json\` and the README for how to run tests and builds before guessing.
- Run the relevant tests (\`php artisan test\`, or \`vendor/bin/pest\` / \`vendor/bin/phpunit\` as the project uses) before saying you are done.
- Follow the existing code style; if the project uses Laravel Pint (\`vendor/bin/pint\`), run it on the files you changed.

## Code
- Validate in Form Requests, authorise in Policies or Gates; keep controllers thin.
- Business logic goes in Actions, Services or models, following the pattern the project already uses.
- Eloquent: define relations, \`$fillable\` (or guarded) and \`casts\`; prevent N+1 with \`with()\`; avoid raw queries unless needed, and always bind parameters.
- JSON responses through API Resources; slow work through Jobs and queues.
- In application code use \`config()\`; \`env()\` only inside \`config/\` files.

## Database and data
- Never edit a migration that has run in another environment; write a new one.
- Never run \`migrate:fresh\`, \`migrate:reset\`, \`db:wipe\` or seeders against a database that is not the user's local one without explicit approval.
- Give new models factories and seeders when the project uses them.

## Security
- Keep secrets out of code and out of files that go into git; do not commit \`.env\`.
- For user data in Blade use \`{{ }}\`, not \`{!! !!}\`.
- Make sure routes that change data are protected by authentication and CSRF (or the matching API authentication).
`,
  },
  filament: {
    id: `# Konvensi Filament

Tambahan untuk proyek yang memakai Filament (di samping aturan Laravel). Periksa dulu versi \`filament/filament\` di \`composer.json\`: API berbeda antar versi mayor, jadi baca dokumentasi untuk versi itu dan jangan mencampur contoh dari versi lain.

- Buat resource, halaman, widget, dan relation manager dengan generator (\`php artisan make:filament-resource\`, \`make:filament-page\`, \`make:filament-widget\`, \`make:filament-relation-manager\`), lalu ubah hasilnya.
- Pisahkan definisi form dan tabel; jadikan kolom bisa dicari atau diurutkan hanya bila memang dipakai.
- Otorisasi lewat Policy Laravel (Filament mengikutinya); jangan hanya menyembunyikan aksi di tampilan.
- Hindari N+1 di tabel: muat relasi lewat query resource, jangan mengakses relasi per baris tanpa eager loading.
- Logika bisnis di Action atau Service, bukan di closure form atau tabel yang panjang.
- Panel dikonfigurasi di \`app/Providers/Filament/*PanelProvider.php\`; ubah di sana.
- Tambahkan tes untuk resource atau aksi baru, memakai helper pengujian yang disarankan dokumentasi Filament untuk versi proyek ini.
- Jalankan tes dan periksa tidak ada error sebelum menyatakan selesai.
`,
    en: `# Filament conventions

Additions for projects that use Filament (alongside the Laravel rules). First check the \`filament/filament\` version in \`composer.json\`: the API differs between major versions, so read the docs for that version and do not mix examples from another one.

- Create resources, pages, widgets and relation managers with the generators (\`php artisan make:filament-resource\`, \`make:filament-page\`, \`make:filament-widget\`, \`make:filament-relation-manager\`), then edit the result.
- Keep form and table definitions apart; make columns searchable or sortable only when they are used that way.
- Authorise through Laravel Policies (Filament follows them); do not only hide actions in the view.
- Avoid N+1 in tables: load relations in the resource query, do not touch a relation per row without eager loading.
- Business logic in Actions or Services, not in long form or table closures.
- Panels are configured in \`app/Providers/Filament/*PanelProvider.php\`; change them there.
- Add tests for new resources or actions, using the testing helpers Filament's docs recommend for this project's version.
- Run the tests and check for errors before saying you are done.
`,
  },
  flutter: {
    id: `# Konvensi Flutter

Periksa \`pubspec.yaml\` (versi SDK dan dependensi) dan struktur \`lib/\` sebelum menulis kode; ikuti pola yang sudah dipakai. Sunting berkas ini sesuai kebiasaan tim.

- Sebelum menyatakan selesai jalankan \`dart format .\`, \`flutter analyze\`, dan \`flutter test\`; perbaiki peringatan yang kamu timbulkan.
- Pakai state management yang sudah ada di proyek (Provider, Riverpod, Bloc, dan sebagainya); jangan memperkenalkan yang baru tanpa diminta.
- Pecah widget menjadi kecil; pakai \`const\` constructor bila bisa; hindari \`setState\` pada widget yang besar.
- Setelah \`await\`, periksa \`mounted\` sebelum memakai \`BuildContext\`.
- Pisahkan UI, state, dan akses data; widget tidak memanggil API langsung.
- Tambah dependensi dengan \`flutter pub add\` (jangan menebak versi); jangan menaikkan versi mayor tanpa persetujuan.
- Jangan mengubah folder platform (\`android/\`, \`ios/\`, dan sejenisnya) atau konfigurasi penandatanganan kecuali diminta.
- Aset dan font didaftarkan di \`pubspec.yaml\`; jalankan \`flutter pub get\` setelah mengubahnya.
- Tulis widget test untuk layar atau komponen baru bila proyek sudah punya tes.
`,
    en: `# Flutter conventions

Check \`pubspec.yaml\` (SDK version and dependencies) and the \`lib/\` structure before writing code; follow the patterns already in use. Edit this file to match the team's habits.

- Before saying you are done run \`dart format .\`, \`flutter analyze\` and \`flutter test\`; fix the warnings you caused.
- Use the state management the project already has (Provider, Riverpod, Bloc and so on); do not introduce a new one unasked.
- Keep widgets small; use \`const\` constructors where possible; avoid \`setState\` in large widgets.
- After an \`await\`, check \`mounted\` before using a \`BuildContext\`.
- Keep UI, state and data access apart; widgets do not call APIs directly.
- Add dependencies with \`flutter pub add\` (do not guess versions); do not bump a major version without approval.
- Do not change platform folders (\`android/\`, \`ios/\` and the like) or signing configuration unless asked.
- Assets and fonts are declared in \`pubspec.yaml\`; run \`flutter pub get\` after changing it.
- Write widget tests for new screens or components when the project already has tests.
`,
  },
  nextjs: {
    id: `# Konvensi Next.js

Periksa versi \`next\` di \`package.json\` dan apakah proyek memakai App Router (\`app/\`) atau Pages Router (\`pages/\`); ikuti yang ada dan jangan mencampurnya. Sunting berkas ini sesuai kebiasaan tim.

- App Router: komponen adalah Server Component secara bawaan; tambahkan \`"use client"\` hanya bila perlu (state, effect, event handler, API browser) dan sekecil mungkin.
- Ambil data di server bila bisa; endpoint di \`route.ts\` (App Router) atau \`pages/api\` (Pages Router).
- Hanya variabel lingkungan berawalan \`NEXT_PUBLIC_\` yang sampai ke browser; rahasia tidak boleh memakai awalan itu atau dikirim ke komponen klien.
- Pakai \`next/link\` dan \`next/image\` untuk navigasi dan gambar internal.
- Jaga TypeScript tetap ketat; jangan menambah \`any\` atau \`@ts-ignore\` hanya untuk menghilangkan error.
- Sebelum menyatakan selesai jalankan perintah yang ada di \`package.json\`: lint, tes, dan \`build\` (build yang gagal sering menyingkap error tipe dan impor).
- Pakai package manager yang sudah dipakai proyek (lihat lockfile: \`package-lock.json\`, \`pnpm-lock.yaml\`, \`yarn.lock\`, atau \`bun.lock\`).
- Jangan menambah dependensi besar untuk hal kecil.
`,
    en: `# Next.js conventions

Check the \`next\` version in \`package.json\` and whether the project uses the App Router (\`app/\`) or the Pages Router (\`pages/\`); follow what exists and do not mix them. Edit this file to match the team's habits.

- App Router: components are Server Components by default; add \`"use client"\` only when needed (state, effects, event handlers, browser APIs) and keep it as small as possible.
- Fetch data on the server where you can; endpoints go in \`route.ts\` (App Router) or \`pages/api\` (Pages Router).
- Only environment variables prefixed \`NEXT_PUBLIC_\` reach the browser; secrets must not use that prefix or be passed to client components.
- Use \`next/link\` and \`next/image\` for internal navigation and images.
- Keep TypeScript strict; do not add \`any\` or \`@ts-ignore\` just to silence an error.
- Before saying you are done run the commands in \`package.json\`: lint, tests and \`build\` (a failing build often exposes type and import errors).
- Use the package manager the project already uses (see the lockfile: \`package-lock.json\`, \`pnpm-lock.yaml\`, \`yarn.lock\` or \`bun.lock\`).
- Do not add a large dependency for a small job.
`,
  },
};

export function stackRules(id: StackId, locale: Locale): string {
  return RULES[id][locale];
}
