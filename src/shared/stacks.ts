// Project templates for popular stacks (phase 7): a rules pack the agent follows from the first file, and prompts to
// start with. The IDE bundles no scaffolds (they go stale within months); a "new project" prompt has the agent run the
// framework's own official command, and every command it runs still asks for permission. No runtime imports:
// compiled into both the host and the webview.

export type StackId = "laravel" | "filament" | "flutter" | "nextjs";

export interface StackInfo {
  id: StackId;
  label: string;
  /** For an existing project of this stack. */
  starters: { id: readonly string[]; en: readonly string[] };
  /** For an empty folder: scaffold with the framework's own command, in a sub-folder. */
  newProject: { id: string; en: string };
}

export const STACKS: readonly StackInfo[] = [
  {
    id: "laravel",
    label: "Laravel",
    starters: {
      id: [
        "Jelaskan struktur proyek Laravel ini: rute, controller, model, dan di mana logika bisnisnya berada.",
        "Tambahkan CRUD untuk model Post lengkap dengan migrasi, model, Form Request, Policy, controller, rute, dan tes.",
        "Cari query N+1 dan masalah keamanan yang jelas di proyek ini, lalu usulkan perbaikannya.",
      ],
      en: [
        "Explain this Laravel project: routes, controllers, models, and where the business logic lives.",
        "Add CRUD for a Post model with migration, model, Form Request, Policy, controller, routes and tests.",
        "Look for N+1 queries and obvious security problems in this project and propose fixes.",
      ],
    },
    newProject: {
      id: "Buat proyek Laravel baru bernama `proyek-saya` di subfolder folder ini dengan perintah resmi `composer create-project laravel/laravel proyek-saya`. Setelah selesai, jelaskan struktur foldernya dan cara menjalankannya.",
      en: "Create a new Laravel project named `my-project` in a sub-folder of this folder with the official command `composer create-project laravel/laravel my-project`. When done, explain its folder structure and how to run it.",
    },
  },
  {
    id: "filament",
    label: "Filament",
    starters: {
      id: [
        "Jelaskan panel Filament di proyek ini: resource, halaman, widget, dan aturan aksesnya.",
        "Buat Filament Resource untuk model Product dengan form, tabel yang bisa dicari dan diurutkan, Policy, dan tes.",
        "Periksa tabel Filament di proyek ini dan perbaiki query N+1 di dalamnya.",
      ],
      en: [
        "Explain the Filament panel in this project: resources, pages, widgets and access rules.",
        "Create a Filament Resource for a Product model with a form, a searchable and sortable table, a Policy and tests.",
        "Review the Filament tables in this project and fix any N+1 queries in them.",
      ],
    },
    newProject: {
      id: "Siapkan proyek Laravel baru bernama `proyek-admin` di subfolder dengan `composer create-project laravel/laravel proyek-admin`, lalu pasang Filament di dalamnya mengikuti dokumentasi resmi Filament untuk versi terbaru (composer require filament/filament, lalu `php artisan filament:install --panels`). Jelaskan langkah yang kamu jalankan.",
      en: "Set up a new Laravel project named `admin-project` in a sub-folder with `composer create-project laravel/laravel admin-project`, then install Filament in it following Filament's official docs for the latest version (composer require filament/filament, then `php artisan filament:install --panels`). Explain the steps you run.",
    },
  },
  {
    id: "flutter",
    label: "Flutter",
    starters: {
      id: [
        "Jelaskan struktur proyek Flutter ini: layar, state management, dan lapisan datanya.",
        "Tambahkan layar daftar dan detail untuk data dari API, lengkap dengan state loading dan error serta widget test.",
        "Jalankan flutter analyze dan perbaiki peringatan yang bisa diperbaiki dengan aman.",
      ],
      en: [
        "Explain this Flutter project: screens, state management and the data layer.",
        "Add a list and detail screen for data from an API, with loading and error states and widget tests.",
        "Run flutter analyze and fix the warnings that can be fixed safely.",
      ],
    },
    newProject: {
      id: "Buat proyek Flutter baru bernama `aplikasi_saya` di subfolder folder ini dengan perintah resmi `flutter create aplikasi_saya`. Setelah selesai, jelaskan struktur foldernya dan cara menjalankannya di emulator.",
      en: "Create a new Flutter project named `my_app` in a sub-folder of this folder with the official command `flutter create my_app`. When done, explain its folder structure and how to run it on an emulator.",
    },
  },
  {
    id: "nextjs",
    label: "Next.js",
    starters: {
      id: [
        "Jelaskan struktur proyek Next.js ini: apakah memakai App Router, rute apa saja yang ada, dan di mana data diambil.",
        "Tambahkan halaman daftar dan halaman detail dengan data dari API, memakai Server Component bila bisa, lengkap dengan loading dan error.",
        "Jalankan lint dan build, lalu perbaiki error tipe dan impor yang muncul.",
      ],
      en: [
        "Explain this Next.js project: whether it uses the App Router, which routes exist and where data is fetched.",
        "Add a list page and a detail page with data from an API, using Server Components where possible, with loading and error states.",
        "Run lint and build, then fix the type and import errors that show up.",
      ],
    },
    newProject: {
      id: "Buat proyek Next.js baru bernama `situs-saya` di subfolder folder ini dengan perintah resmi `npx create-next-app@latest situs-saya`; gunakan flag agar tidak interaktif (lihat `--help`). Setelah selesai, jelaskan struktur foldernya dan cara menjalankannya.",
      en: "Create a new Next.js project named `my-site` in a sub-folder of this folder with the official command `npx create-next-app@latest my-site`; use flags so it is not interactive (see `--help`). When done, explain its folder structure and how to run it.",
    },
  },
];

export function stackInfo(id: string): StackInfo | undefined {
  return STACKS.find((s) => s.id === id);
}

export function isStackId(value: unknown): value is StackId {
  return typeof value === "string" && STACKS.some((s) => s.id === value);
}
