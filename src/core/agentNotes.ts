// Short instructions the IDE puts in front of the agent's prompt (phase 7): which language to answer in, and learning
// mode. They are written for the model, in the language they ask for, and are kept brief because they travel with
// the prompt. No runtime imports: compiled into both the host and the webview.
import type { Locale } from "../shared/strings";

export type AgentLanguageSetting = "ui" | "id" | "en" | "off";
export type LearningLevel = "beginner" | "intermediate";

export function parseAgentLanguage(value: unknown): AgentLanguageSetting {
  return value === "id" || value === "en" || value === "off" ? value : "ui";
}

export function parseLearningLevel(value: unknown): LearningLevel {
  return value === "intermediate" ? "intermediate" : "beginner";
}

/** The language the agent should answer in, or undefined when the IDE should say nothing about it. */
export function effectiveAgentLanguage(setting: AgentLanguageSetting, ui: Locale): Locale | undefined {
  if (setting === "off") return undefined;
  return setting === "ui" ? ui : setting;
}

const LANGUAGE_NOTE: Record<Locale, string> = {
  id: "[IDE] Jawab dalam bahasa Indonesia yang jelas dan natural, kecuali pengguna menulis dalam bahasa lain atau memintanya. Biarkan kode, nama berkas, perintah, dan istilah teknis baku tetap dalam bentuk aslinya.",
  en: "[IDE] Reply in English, unless the user writes in another language or asks for one. Keep code, file names and commands as they are.",
};

export function languageNote(language: Locale): string {
  return LANGUAGE_NOTE[language];
}

const LEARNING_NOTE: Record<Locale, Record<LearningLevel, string>> = {
  id: {
    beginner:
      "[Mode belajar] Pengguna sedang belajar, jadi jelaskan sambil bekerja. Sebelum mengubah berkas, tulis dengan bahasa sederhana apa yang akan kamu ubah dan MENGAPA, satu perubahan per langkah. " +
      "Artikan istilah teknis saat pertama muncul dan beri contoh kecil bila membantu. Setelah selesai, rangkum: apa yang berubah, kenapa, dan konsep kuncinya. Jangan mengubah hal yang tidak diminta. " +
      "Akhiri dengan satu pertanyaan singkat atau saran langkah belajar berikutnya.",
    intermediate:
      "[Mode belajar] Pengguna ingin memahami keputusanmu. Sebelum mengubah berkas, jelaskan singkat apa yang berubah dan alasannya, termasuk alternatif yang kamu pertimbangkan dan kompromi yang kamu pilih. " +
      "Setelah selesai, rangkum perubahan beserta risiko dan hal yang perlu diuji. Jangan mengubah hal yang tidak diminta.",
  },
  en: {
    beginner:
      "[Learning mode] The user is learning, so explain as you work. Before changing a file, say in plain words what you are about to change and WHY, one change per step. " +
      "Define technical terms the first time they appear and give a small example when it helps. When done, summarise: what changed, why, and the key concept. Do not change anything that was not asked for. " +
      "End with one short question or a suggestion for what to learn next.",
    intermediate:
      "[Learning mode] The user wants to understand your decisions. Before changing a file, briefly explain what changes and why, including the alternatives you considered and the trade-off you chose. " +
      "When done, summarise the change with its risks and what should be tested. Do not change anything that was not asked for.",
  },
};

export function learningNote(language: Locale, level: LearningLevel): string {
  return LEARNING_NOTE[language][level];
}
