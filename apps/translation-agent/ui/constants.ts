import { Tiktoken } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import type { Locale } from './types';

export const LOCALES: Locale[] = [
  // English added for UI-8255 (Support team source/target use case).
  // Listed first because it's the most common source AND a frequent
  // target for non-English customer messages.
  { code: 'en-US', name: 'English', variant: 'United States' },
  { code: 'es-ES', name: 'Spanish', variant: 'Spain' },
  { code: 'fr-FR', name: 'French', variant: 'France' },
  { code: 'de-DE', name: 'German', variant: 'Germany' },
  { code: 'it-IT', name: 'Italian', variant: 'Italy' },
  { code: 'pt-BR', name: 'Portuguese', variant: 'Brazil' },
  { code: 'zh-CN', name: 'Chinese', variant: 'Mainland China' },
  { code: 'ja-JP', name: 'Japanese', variant: 'Japan' },
  { code: 'ko-KR', name: 'Korean', variant: 'South Korea' },
  { code: 'zh-TW', name: 'Chinese', variant: 'Taiwan' }
];

export const ADDITIONAL_LOCALES: Locale[] = [
  { code: 'ar-EG', name: 'Arabic', variant: 'Egypt' },
  { code: 'bg-BG', name: 'Bulgarian', variant: 'Bulgaria' },
  { code: 'hr-HR', name: 'Croatian', variant: 'Croatia' },
  { code: 'cs-CZ', name: 'Czech', variant: 'Czech Republic' },
  { code: 'da-DK', name: 'Danish', variant: 'Denmark' },
  { code: 'nl-NL', name: 'Dutch', variant: 'Netherlands' },
  { code: 'fa-IR', name: 'Persian', variant: 'Iran' },
  { code: 'fi-FI', name: 'Finnish', variant: 'Finland' },
  { code: 'el-GR', name: 'Greek', variant: 'Greece' },
  { code: 'he-IL', name: 'Hebrew', variant: 'Israel' },
  { code: 'hi-IN', name: 'Hindi', variant: 'India' },
  { code: 'hu-HU', name: 'Hungarian', variant: 'Hungary' },
  { code: 'id-ID', name: 'Indonesian', variant: 'Indonesia' },
  { code: 'lv-LV', name: 'Latvian', variant: 'Latvia' },
  { code: 'lt-LT', name: 'Lithuanian', variant: 'Lithuania' },
  { code: 'ms-MY', name: 'Malay', variant: 'Malaysia' },
  { code: 'nb-NO', name: 'Norwegian', variant: 'Norway' },
  { code: 'pl-PL', name: 'Polish', variant: 'Poland' },
  { code: 'ro-RO', name: 'Romanian', variant: 'Romania' },
  { code: 'ru-RU', name: 'Russian', variant: 'Russia' },
  { code: 'sr-BA', name: 'Serbian', variant: 'Bosnia' },
  { code: 'sk-SK', name: 'Slovak', variant: 'Slovakia' },
  { code: 'sl-SI', name: 'Slovenian', variant: 'Slovenia' },
  { code: 'sv-SE', name: 'Swedish', variant: 'Sweden' },
  { code: 'tl-PH', name: 'Tagalog', variant: 'Philippines' },
  { code: 'th-TH', name: 'Thai', variant: 'Thailand' },
  { code: 'tr-TR', name: 'Turkish', variant: 'Turkey' },
  { code: 'uk-UA', name: 'Ukrainian', variant: 'Ukraine' },
  { code: 'vi-VN', name: 'Vietnamese', variant: 'Vietnam' }
];

export const ALL_LOCALES = [...LOCALES, ...ADDITIONAL_LOCALES];
export const LOCALES_MAP = new Map(
  ALL_LOCALES.map((locale) => [locale.code, locale])
);
export const TOKEN_LIMIT = 5000;

export const MODELS = [
  { value: 'llama', label: 'Llama 4 Scout' },
  { value: 'gpt', label: 'GPT OSS 120B' },
  { value: 'kimi2_5', label: 'Kimi K2.5' },
  { value: 'qwen', label: 'Qwen3 30B' },
  { value: 'glm', label: 'GLM 4.7 Flash' }
] as const;

export const encoder = new Tiktoken(cl100k_base);
