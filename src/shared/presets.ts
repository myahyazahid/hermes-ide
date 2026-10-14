// Starting points for the Custom API form (onboarding, phase 5; providers within reach from Indonesia, phase 7).
// Prices, plans and model names change too often to list here, so a preset only fills in the endpoint address, says
// in a sentence what kind of provider it is, and links to where the key and the current prices are. The address of
// every remote preset answered (asking for a key) when it was checked on 2026-10-10; that is all that was verified.
// No runtime imports: compiled into both the host and the webview.

export type PresetGroup = "local" | "gateway" | "direct";

export interface EndpointPreset {
  id: string;
  label: string;
  group: PresetGroup;
  baseUrl: string;
  /** Shown as the placeholder of the model field. */
  modelHint: string;
  needsKey: boolean;
  /** The request leaves this computer. Local servers are the only presets where it does not. */
  remote: boolean;
  /** One or two sentences about this provider, in each language. */
  note: { id: string; en: string };
  /** Where to get a key or how to start the server. */
  helpUrl?: string;
  /** Where the current prices are published. */
  pricingUrl?: string;
}

export const ENDPOINT_PRESETS: readonly EndpointPreset[] = [
  {
    id: "ollama", label: "Ollama", group: "local", baseUrl: "http://localhost:11434/v1", modelHint: "qwen2.5-coder:7b", needsKey: false, remote: false,
    note: {
      id: "Berjalan di komputermu: tanpa biaya per token dan kode tidak keluar. Pilih model yang mendukung tool calling dan naikkan panjang konteks ke 64k atau lebih (lihat dokumentasi Ollama, mis. variabel OLLAMA_CONTEXT_LENGTH).",
      en: "Runs on your computer: no per-token cost and the code stays here. Pick a model with tool calling and raise the context length to 64k or more (see Ollama's docs, e.g. the OLLAMA_CONTEXT_LENGTH variable).",
    },
    helpUrl: "https://ollama.com/download",
  },
  {
    id: "lmstudio", label: "LM Studio", group: "local", baseUrl: "http://localhost:1234/v1", modelHint: "", needsKey: false, remote: false,
    note: {
      id: "Aplikasi desktop dengan server lokal (nyalakan di tab Developer). Muat model dengan konteks 64k atau lebih dan dukungan tool calling.",
      en: "A desktop app with a local server (turn it on in the Developer tab). Load a model with a 64k or larger context and tool calling.",
    },
    helpUrl: "https://lmstudio.ai/",
  },
  {
    id: "vllm", label: "vLLM / server sendiri", group: "local", baseUrl: "http://localhost:8000/v1", modelHint: "", needsKey: false, remote: false,
    note: {
      id: "Untuk GPU atau VPS milikmu sendiri. Ganti alamat dengan servermu; bila di luar komputer ini, daftarkan hostnya di mode lokal penuh.",
      en: "For your own GPU or VPS. Replace the address with your server; if it is not this computer, list its host in full local mode.",
    },
    helpUrl: "https://docs.vllm.ai/en/latest/",
  },
  {
    id: "flaz", label: "Flaz Cloud", group: "gateway", baseUrl: "https://ai.flaz.id/v1", modelHint: "", needsKey: true, remote: true,
    note: {
      id: "Gateway Indonesia: banyak model lewat satu endpoint. Menurut halaman penyedia, saldo diisi dalam rupiah (QRIS, transfer bank, e-wallet) dan dibayar sesuai pemakaian. Itu keterangan penyedia; periksa sendiri syarat, harga, dan kebijakan datanya. Prompt melewati server mereka.",
      en: "An Indonesian gateway: many models through one endpoint. According to the provider's page you top up in rupiah (QRIS, bank transfer, e-wallet) and pay as you go. That is the provider's own description; check the terms, prices and data policy yourself. Prompts pass through their servers.",
    },
    helpUrl: "https://flaz.id/en/ai-services",
  },
  {
    id: "sumopod", label: "SumoPod", group: "gateway", baseUrl: "https://ai.sumopod.com/v1", modelHint: "", needsKey: true, remote: true,
    note: {
      id: "Gateway Indonesia dengan banyak model lewat satu endpoint; key dibuat di dasbor ai.sumopod.com (tab AI, lalu API Keys). Cek metode pembayaran, mata uang harga, dan kebijakan datanya di situs mereka. Prompt melewati server mereka.",
      en: "An Indonesian gateway with many models through one endpoint; create the key in the ai.sumopod.com dashboard (AI tab, then API Keys). Check the payment methods, price currency and data policy on their site. Prompts pass through their servers.",
    },
    helpUrl: "https://sumopod.com/",
  },
  {
    id: "deepseek", label: "DeepSeek", group: "direct", baseUrl: "https://api.deepseek.com", modelHint: "", needsKey: true, remote: true,
    note: {
      id: "Penyedia langsung dengan API yang kompatibel dengan OpenAI. Nama model dan harga berubah; baca halaman harga resminya dan ambil daftar model setelah mengisi key.",
      en: "A direct provider with an OpenAI-compatible API. Model names and prices change; read its official pricing page and fetch the model list once the key is entered.",
    },
    helpUrl: "https://api-docs.deepseek.com/", pricingUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
  },
  {
    id: "moonshot", label: "Moonshot (Kimi)", group: "direct", baseUrl: "https://api.moonshot.ai/v1", modelHint: "", needsKey: true, remote: true,
    note: {
      id: "Penyedia langsung (endpoint internasional). Key dibuat di konsolnya; cek di sana syarat saldo awal dan harga terbaru.",
      en: "A direct provider (international endpoint). Create the key in its console; check there for any starting balance and the current prices.",
    },
    helpUrl: "https://platform.kimi.ai/",
  },
  {
    id: "zai", label: "Z.ai (GLM)", group: "direct", baseUrl: "https://api.z.ai/api/paas/v4", modelHint: "", needsKey: true, remote: true,
    note: {
      id: "Penyedia langsung (endpoint internasional, tagihan USD). Paket langganan khusus coding memakai alamat lain; lihat dokumentasinya sebelum memilih.",
      en: "A direct provider (international endpoint, billed in USD). Its coding subscription plan uses a different address; read its docs before choosing.",
    },
    helpUrl: "https://docs.z.ai/guides/overview/quick-start",
  },
  {
    id: "dashscope", label: "Alibaba Qwen (Model Studio)", group: "direct", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", modelHint: "", needsKey: true, remote: true,
    note: {
      id: "Qwen lewat Alibaba Cloud Model Studio. Dokumentasi terbaru menyebut alamat per wilayah atau workspace; bila alamat ini ditolak, salin alamat dari konsolmu.",
      en: "Qwen through Alibaba Cloud Model Studio. Its newer docs give an address per region or workspace; if this one is rejected, copy the address from your console.",
    },
    helpUrl: "https://www.alibabacloud.com/help/model-studio/",
  },
  {
    id: "siliconflow", label: "SiliconFlow", group: "direct", baseUrl: "https://api.siliconflow.com/v1", modelHint: "", needsKey: true, remote: true,
    note: {
      id: "Penyedia langsung yang menyajikan banyak model terbuka (Qwen, DeepSeek, GLM, dan lain-lain). Cek harga dan syarat di situsnya.",
      en: "A direct provider serving many open models (Qwen, DeepSeek, GLM and others). Check the prices and terms on its site.",
    },
    helpUrl: "https://www.siliconflow.com/",
  },
  {
    id: "groq", label: "Groq", group: "direct", baseUrl: "https://api.groq.com/openai/v1", modelHint: "", needsKey: true, remote: true,
    note: {
      id: "Inferensi cepat untuk model terbuka. Pastikan modelnya mendukung tool calling dan batas konteksnya cukup (lihat Tes koneksi).",
      en: "Fast inference for open models. Make sure the model supports tool calling and its context limit is enough (see Test connection).",
    },
    helpUrl: "https://console.groq.com/",
  },
  {
    id: "openrouter", label: "OpenRouter", group: "direct", baseUrl: "https://openrouter.ai/api/v1", modelHint: "anthropic/claude-sonnet-4.5", needsKey: true, remote: true,
    note: {
      id: "Satu key untuk banyak model dari banyak penyedia; cocok untuk mencoba-coba. Harga per model tertera di situsnya.",
      en: "One key for many models from many providers; good for trying things out. Each model's price is listed on its site.",
    },
    helpUrl: "https://openrouter.ai/keys", pricingUrl: "https://openrouter.ai/models",
  },
];

export const PRESET_GROUPS: readonly PresetGroup[] = ["local", "gateway", "direct"];

/** Only addresses that appear in the table above may be opened from the panel. */
export function isPresetUrl(url: string): boolean {
  return ENDPOINT_PRESETS.some((p) => p.helpUrl === url || p.pricingUrl === url);
}

/** Things worth trying first in a fresh workspace; clicking one puts it in the composer. */
export const STARTER_PROMPTS: Record<"id" | "en", readonly string[]> = {
  id: [
    "Jelaskan struktur proyek ini dan di mana titik masuk utamanya.",
    "Cari bug yang jelas di file yang sedang saya buka dan usulkan perbaikannya.",
    "Buat README yang menjelaskan cara menjalankan dan menguji proyek ini.",
  ],
  en: [
    "Explain the structure of this project and where its main entry point is.",
    "Look for obvious bugs in the file I have open and propose fixes.",
    "Write a README that explains how to run and test this project.",
  ],
};
