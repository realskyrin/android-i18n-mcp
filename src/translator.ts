import OpenAI from 'openai';

export interface TranslationProvider {
  translate(text: string, targetLanguage: string, sourceLanguage?: string): Promise<string>;
  translateBatch(texts: Map<string, string>, targetLanguage: string, sourceLanguage?: string): Promise<Map<string, string>>;
}

export interface TranslatorConfig {
  provider: 'openai' | 'deepseek' | 'anthropic' | 'google';
  apiKey: string;
  baseUrl?: string;
  model?: string;
  translationLanguages?: string[];  // Optional: specify which languages to translate to
}

const LANGUAGE_MAPPING: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese (Taiwan)',
  'zh-SG': 'Traditional Chinese (Singapore)',
  'zh-HK': 'Traditional Chinese (Hong Kong)',
  'zh-MO': 'Traditional Chinese (Macau)',
  'en': 'English',
  'es': 'Spanish',
  'hi': 'Hindi',
  'fr': 'French',
  'ar': 'Arabic',
  'bn': 'Bengali',
  'pt': 'Portuguese',
  'ru': 'Russian',
  'ur': 'Urdu',
  'id': 'Indonesian',
  'de': 'German',
  'ja': 'Japanese',
  'sw': 'Swahili',
  'mr': 'Marathi',
  'te': 'Telugu',
  'tr': 'Turkish',
  'ko': 'Korean',
  'ta': 'Tamil',
  'vi': 'Vietnamese',
  'az': 'Azerbaijani',
  'be': 'Belarusian',
  'it': 'Italian',
  'uk': 'Ukrainian'
};

export class OpenAITranslator implements TranslationProvider {
  private client: OpenAI;
  private model: string;
  private static readonly DEFAULT_TIMEOUT_MS = 60_000; // 60s per request
  private static readonly MAX_BATCH_SIZE = 60; // limit items per batch to keep prompts small
  private static readonly NEWLINE_PLACEHOLDER = '__NEWLINE__';

  constructor(config: TranslatorConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: OpenAITranslator.DEFAULT_TIMEOUT_MS,
      maxRetries: 2
    });
    this.model = config.model || 'gpt-4o-mini';
  }

  private escapeNewlines(text: string): string {
    return text.replace(/\\n/g, OpenAITranslator.NEWLINE_PLACEHOLDER);
  }

  private unescapeNewlines(text: string): string {
    return text.replace(new RegExp(OpenAITranslator.NEWLINE_PLACEHOLDER, 'g'), '\\n');
  }

  async translate(text: string, targetLanguage: string, sourceLanguage: string = 'en'): Promise<string> {
    const targetLangName = LANGUAGE_MAPPING[targetLanguage] || targetLanguage;
    const sourceLangName = LANGUAGE_MAPPING[sourceLanguage] || sourceLanguage;

    // Escape newlines before translation
    const escapedText = this.escapeNewlines(text);

    const prompt = `Translate the following Android app string resource from ${sourceLangName} to ${targetLangName}.
Keep the translation natural and appropriate for mobile UI.
Preserve any placeholders like %s, %d, %1$s, etc.
IMPORTANT: Preserve the placeholder ${OpenAITranslator.NEWLINE_PLACEHOLDER} exactly as it appears - do not translate or modify it.
Only return the translated text without any explanation.

Text to translate: "${escapedText}"`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a professional translator specializing in mobile app localization. You preserve formatting placeholders and ensure translations are concise and appropriate for UI elements.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 500
      });

      const translatedText = response.choices[0]?.message?.content?.trim() || escapedText;
      // Unescape newlines after translation
      return this.unescapeNewlines(translatedText);
    } catch (error) {
      console.error(`Translation error for ${targetLanguage}:`, error);
      throw error;
    }
  }

  private async translateBatchChunk(texts: Map<string, string>, targetLanguage: string, sourceLanguage: string = 'en'): Promise<Map<string, string>> {
    const targetLangName = LANGUAGE_MAPPING[targetLanguage] || targetLanguage;
    const sourceLangName = LANGUAGE_MAPPING[sourceLanguage] || sourceLanguage;

    const entries = Array.from(texts.entries());
    if (entries.length === 0) {
      return new Map();
    }

    // Escape newlines in all texts before translation
    const escapedEntries = entries.map(([key, value]) => [key, this.escapeNewlines(value)]);
    const jsonInput = Object.fromEntries(escapedEntries);

    const prompt = `Translate the following Android app string resources from ${sourceLangName} to ${targetLangName}.
Keep translations natural and appropriate for mobile UI.
Preserve any placeholders like %s, %d, %1$s, etc.
IMPORTANT: Preserve the placeholder ${OpenAITranslator.NEWLINE_PLACEHOLDER} exactly as it appears - do not translate or modify it.
Return ONLY a JSON object with the same keys and translated values.

Input JSON:
${JSON.stringify(jsonInput, null, 2)}`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a professional translator specializing in mobile app localization. Return only valid JSON with translated values. Preserve all formatting placeholders.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 4000,
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response content');
      }

      const translatedJson = JSON.parse(content);
      // Unescape newlines in all translated texts
      const results = new Map<string, string>();
      for (const [key, value] of Object.entries(translatedJson)) {
        results.set(key, this.unescapeNewlines(value as string));
      }
      return results;
    } catch (error) {
      console.error(`Batch translation error for ${targetLanguage}:`, error);

      const results = new Map<string, string>();
      for (const [key, value] of texts) {
        try {
          const translated = await this.translate(value, targetLanguage, sourceLanguage);
          results.set(key, translated);
        } catch (e) {
          console.error(`Failed to translate key "${key}":`, e);
          results.set(key, value);
        }
      }
      return results;
    }
  }

  async translateBatch(texts: Map<string, string>, targetLanguage: string, sourceLanguage: string = 'en'): Promise<Map<string, string>> {
    const size = texts.size;
    if (size <= OpenAITranslator.MAX_BATCH_SIZE) {
      return this.translateBatchChunk(texts, targetLanguage, sourceLanguage);
    }

    // Chunk large batches to avoid timeouts and context overflows
    const keys = Array.from(texts.keys());
    const results = new Map<string, string>();
    for (let i = 0; i < keys.length; i += OpenAITranslator.MAX_BATCH_SIZE) {
      const sliceKeys = keys.slice(i, i + OpenAITranslator.MAX_BATCH_SIZE);
      const chunk = new Map<string, string>();
      for (const k of sliceKeys) chunk.set(k, texts.get(k)!);

      const translatedChunk = await this.translateBatchChunk(chunk, targetLanguage, sourceLanguage);
      for (const [k, v] of translatedChunk) {
        results.set(k, v);
      }
    }
    return results;
  }
}

export class DeepSeekTranslator extends OpenAITranslator {
  constructor(config: TranslatorConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.deepseek.com',
      model: config.model || 'deepseek-chat'
    });
  }
}

export class TranslatorFactory {
  static create(config: TranslatorConfig): TranslationProvider {
    switch (config.provider) {
      case 'openai':
        return new OpenAITranslator(config);
      case 'deepseek':
        return new DeepSeekTranslator(config);
      case 'anthropic':
        throw new Error('Anthropic provider not yet implemented');
      case 'google':
        throw new Error('Google Translate provider not yet implemented');
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }
}
