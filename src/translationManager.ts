import * as path from 'path';
import { glob } from 'glob';
import { AndroidXMLParser } from './xmlParser.js';
import { GitDiffAnalyzer, DiffResult } from './gitDiff.js';
import { TranslationProvider, TranslatorConfig, TranslatorFactory } from './translator.js';

export interface TranslationResult {
  language: string;
  filePath: string;
  translatedCount: number;
  errors: string[];
}

export interface TranslationSummary {
  totalStrings: number;
  addedStrings: number;
  modifiedStrings: number;
  deletedStrings: number;
  languages: TranslationResult[];
  success: boolean;
}

export class TranslationManager {
  private xmlParser: AndroidXMLParser;
  private translator: TranslationProvider;
  private projectRoot: string;
  private languagesToTranslate: string[];
  
  private readonly SUPPORTED_LANGUAGES = [
    'zh-CN', 'zh-TW', 'zh-SG', 'zh-HK', 'zh-MO',
    'en', 'es', 'hi', 'fr', 'ar', 'bn', 'pt', 'ru',
    'ur', 'id', 'de', 'ja', 'sw', 'mr', 'te', 'tr',
    'ko', 'ta', 'vi', 'az', 'be', 'it', 'uk'
  ];
  
  private readonly LANGUAGE_FOLDER_MAP: Record<string, string> = {
    'zh-CN': 'values-zh-rCN',
    'zh-TW': 'values-zh-rTW',
    'zh-SG': 'values-zh-rSG',
    'zh-HK': 'values-zh-rHK',
    'zh-MO': 'values-zh-rMO',
    'en': 'values-en',
    'es': 'values-es',
    'hi': 'values-hi',
    'fr': 'values-fr',
    'ar': 'values-ar',
    'bn': 'values-bn',
    'pt': 'values-pt',
    'ru': 'values-ru',
    'ur': 'values-ur',
    'id': 'values-id',
    'de': 'values-de',
    'ja': 'values-ja',
    'sw': 'values-sw',
    'mr': 'values-mr',
    'te': 'values-te',
    'tr': 'values-tr',
    'ko': 'values-ko',
    'ta': 'values-ta',
    'vi': 'values-vi',
    'az': 'values-az',
    'be': 'values-be',
    'it': 'values-it',
    'uk': 'values-uk'
  };

  constructor(projectRoot: string, translatorConfig: TranslatorConfig) {
    this.projectRoot = projectRoot;
    this.xmlParser = new AndroidXMLParser();
    this.translator = TranslatorFactory.create(translatorConfig);
    
    // Validate and set languages to translate
    if (translatorConfig.translationLanguages && translatorConfig.translationLanguages.length > 0) {
      this.languagesToTranslate = this.validateLanguages(translatorConfig.translationLanguages);
    } else {
      // Default to all supported languages if not configured
      this.languagesToTranslate = [...this.SUPPORTED_LANGUAGES];
    }
  }

  private validateLanguages(configuredLanguages: string[]): string[] {
    const validLanguages: string[] = [];
    const unsupportedLanguages: string[] = [];
    
    for (const lang of configuredLanguages) {
      if (this.SUPPORTED_LANGUAGES.includes(lang)) {
        validLanguages.push(lang);
      } else {
        unsupportedLanguages.push(lang);
      }
    }
    
    if (unsupportedLanguages.length > 0) {
      console.warn(`⚠️  Warning: The following languages are not supported and will be ignored:`);
      console.warn(`   ${unsupportedLanguages.join(', ')}`);
      console.warn(`\n   Supported languages are:`);
      console.warn(`   ${this.SUPPORTED_LANGUAGES.join(', ')}\n`);
    }
    
    if (validLanguages.length === 0) {
      console.warn(`⚠️  Warning: No valid languages found in configuration. Using all supported languages.`);
      return [...this.SUPPORTED_LANGUAGES];
    }
    
    return validLanguages;
  }

  async findDefaultStringsFiles(): Promise<string[]> {
    const pattern = path.join(this.projectRoot, '**/src/main/res/values/strings.xml');
    const files = await glob(pattern, { absolute: true });
    return files;
  }

  async translateModule(defaultStringsPath: string): Promise<TranslationSummary> {
    const summary: TranslationSummary = {
      totalStrings: 0,
      addedStrings: 0,
      modifiedStrings: 0,
      deletedStrings: 0,
      languages: [],
      success: true
    };

    try {
      const gitAnalyzer = new GitDiffAnalyzer(this.projectRoot);
      const changes = await gitAnalyzer.getDefaultStringsChanges(
        path.relative(this.projectRoot, defaultStringsPath)
      );

      summary.addedStrings = changes.added.size;
      summary.modifiedStrings = changes.modified.size;
      summary.deletedStrings = changes.deleted.size;
      summary.totalStrings = changes.added.size + changes.modified.size;

      // Check if we need to process: either content changes or order changes
      const hasContentChanges = summary.totalStrings > 0 || changes.deleted.size > 0;
      const hasOrderChanges = changes.orderChanged;

      if (!hasContentChanges && !hasOrderChanges) {
        console.log(`No changes detected in ${defaultStringsPath}`);
        return summary;
      }

      if (hasOrderChanges && !hasContentChanges) {
        console.log(`Order changes detected in ${defaultStringsPath}, syncing all language files...`);
      }

      // Use the order from git diff analysis
      const keyOrder = changes.currentOrder;
      const stringsToTranslate = new Map([...changes.added, ...changes.modified]);
      
      const moduleDir = path.dirname(path.dirname(defaultStringsPath));
      
      // Process configured languages in parallel
      const translationPromises = this.languagesToTranslate.map(lang => 
        this.translateLanguage(
          moduleDir,
          lang,
          stringsToTranslate,
          changes.deleted,
          keyOrder,
          hasOrderChanges
        )
      );
      
      const results = await Promise.all(translationPromises);
      
      // Process results
      for (const result of results) {
        summary.languages.push(result);
        if (result.errors.length > 0) {
          summary.success = false;
        }
      }
    } catch (error) {
      console.error(`Error processing module ${defaultStringsPath}:`, error);
      summary.success = false;
    }

    return summary;
  }

  private async translateLanguage(
    moduleDir: string,
    language: string,
    stringsToTranslate: Map<string, string>,
    deletedKeys: Set<string>,
    keyOrder: string[],
    forceOrderSync: boolean = false
  ): Promise<TranslationResult> {
    const result: TranslationResult = {
      language,
      filePath: '',
      translatedCount: 0,
      errors: []
    };

    try {
      const langFolder = this.LANGUAGE_FOLDER_MAP[language];
      const targetPath = path.join(moduleDir, langFolder, 'strings.xml');
      result.filePath = targetPath;

      if (stringsToTranslate.size > 0) {
        console.log(`Translating ${stringsToTranslate.size} strings to ${language}...`);
        
        const translations = await this.translator.translateBatch(
          stringsToTranslate,
          language,
          'en'
        );
        
        await this.xmlParser.mergeTranslationsWithOrder(targetPath, translations, keyOrder);
        result.translatedCount = translations.size;
      } else if (deletedKeys.size > 0 || forceOrderSync) {
        // Sync the order with default file even if no new translations
        const existingStrings = await this.xmlParser.parseStringsXML(targetPath);
        const orderedStrings = new Map<string, import('./xmlParser.js').StringResource>();
        
        // Reorder according to keyOrder and remove deleted keys
        for (const key of keyOrder) {
          if (!deletedKeys.has(key) && existingStrings.has(key)) {
            orderedStrings.set(key, existingStrings.get(key)!);
          }
        }
        
        await this.xmlParser.writeStringsXML(targetPath, orderedStrings);
        console.log(`Synced order for ${language}`);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push(`Failed to translate to ${language}: ${errorMessage}`);
      console.error(`Translation error for ${language}:`, error);
    }

    return result;
  }

  async translateAllModules(): Promise<TranslationSummary[]> {
    const defaultFiles = await this.findDefaultStringsFiles();
    
    if (defaultFiles.length === 0) {
      throw new Error('No default strings.xml files found in the project');
    }

    console.log(`Found ${defaultFiles.length} modules to process`);
    
    const summaries: TranslationSummary[] = [];
    
    for (const defaultFile of defaultFiles) {
      console.log(`\nProcessing: ${path.relative(this.projectRoot, defaultFile)}`);
      const summary = await this.translateModule(defaultFile);
      summaries.push(summary);
    }

    return summaries;
  }

  async translateSpecificModule(modulePath: string): Promise<TranslationSummary> {
    const defaultStringsPath = path.join(modulePath, 'src/main/res/values/strings.xml');
    return await this.translateModule(defaultStringsPath);
  }
}