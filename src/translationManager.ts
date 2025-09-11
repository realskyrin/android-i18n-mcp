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
  
  private readonly SUPPORTED_LANGUAGES = [
    'az', 'be', 'en', 'es', 'id', 'it', 'ru', 'tr', 'uk', 'zh-CN', 'zh-TW'
  ];
  
  private readonly LANGUAGE_FOLDER_MAP: Record<string, string> = {
    'az': 'values-az',
    'be': 'values-be',
    'en': 'values-en',
    'es': 'values-es',
    'id': 'values-id',
    'it': 'values-it',
    'ru': 'values-ru',
    'tr': 'values-tr',
    'uk': 'values-uk',
    'zh-CN': 'values-zh-rCN',
    'zh-TW': 'values-zh-rTW'
  };

  constructor(projectRoot: string, translatorConfig: TranslatorConfig) {
    this.projectRoot = projectRoot;
    this.xmlParser = new AndroidXMLParser();
    this.translator = TranslatorFactory.create(translatorConfig);
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

      if (summary.totalStrings === 0 && changes.deleted.size === 0) {
        console.log(`No changes detected in ${defaultStringsPath}`);
        return summary;
      }

      const stringsToTranslate = new Map([...changes.added, ...changes.modified]);
      
      const moduleDir = path.dirname(path.dirname(defaultStringsPath));
      
      // Process all languages in parallel
      const translationPromises = this.SUPPORTED_LANGUAGES.map(lang => 
        this.translateLanguage(
          moduleDir,
          lang,
          stringsToTranslate,
          changes.deleted
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
    deletedKeys: Set<string>
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
        
        await this.xmlParser.mergeTranslations(targetPath, translations);
        result.translatedCount = translations.size;
      }

      if (deletedKeys.size > 0) {
        const existingStrings = await this.xmlParser.parseStringsXML(targetPath);
        for (const key of deletedKeys) {
          existingStrings.delete(key);
        }
        await this.xmlParser.writeStringsXML(targetPath, existingStrings);
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