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
}

const LANGUAGE_MAPPING: Record<string, string> = {
  'az': 'Azerbaijani',
  'be': 'Belarusian', 
  'en': 'English',
  'es': 'Spanish',
  'id': 'Indonesian',
  'it': 'Italian',
  'ru': 'Russian',
  'tr': 'Turkish',
  'uk': 'Ukrainian',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese'
};

export class OpenAITranslator implements TranslationProvider {
  private client: OpenAI;
  private model: string;

  constructor(config: TranslatorConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl
    });
    this.model = config.model || 'gpt-4o-mini';
  }

  async translate(text: string, targetLanguage: string, sourceLanguage: string = 'en'): Promise<string> {
    const targetLangName = LANGUAGE_MAPPING[targetLanguage] || targetLanguage;
    const sourceLangName = LANGUAGE_MAPPING[sourceLanguage] || sourceLanguage;

    const prompt = `Translate the following Android app string resource from ${sourceLangName} to ${targetLangName}. 
Keep the translation natural and appropriate for mobile UI. 
Preserve any placeholders like %s, %d, %1$s, etc.
Only return the translated text without any explanation.

Text to translate: "${text}"`;

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

      return response.choices[0]?.message?.content?.trim() || text;
    } catch (error) {
      console.error(`Translation error for ${targetLanguage}:`, error);
      throw error;
    }
  }

  async translateBatch(texts: Map<string, string>, targetLanguage: string, sourceLanguage: string = 'en'): Promise<Map<string, string>> {
    const targetLangName = LANGUAGE_MAPPING[targetLanguage] || targetLanguage;
    const sourceLangName = LANGUAGE_MAPPING[sourceLanguage] || sourceLanguage;
    
    const entries = Array.from(texts.entries());
    if (entries.length === 0) {
      return new Map();
    }

    const jsonInput = Object.fromEntries(entries);
    
    const prompt = `Translate the following Android app string resources from ${sourceLangName} to ${targetLangName}.
Keep translations natural and appropriate for mobile UI.
Preserve any placeholders like %s, %d, %1$s, etc.
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
      return new Map(Object.entries(translatedJson));
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