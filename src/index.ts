#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { TranslationManager, TranslationSummary } from './translationManager.js';
import { TranslatorConfig } from './translator.js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

const DEFAULT_PROJECT_ROOT = process.env.ANDROID_PROJECT_ROOT || process.cwd();
const TRANSLATION_PROVIDER = process.env.TRANSLATION_PROVIDER || 'openai';
const API_KEY = process.env.TRANSLATION_API_KEY || '';
const API_BASE_URL = process.env.TRANSLATION_API_BASE_URL;
const TRANSLATION_MODEL = process.env.TRANSLATION_MODEL;

if (!API_KEY) {
  console.error('Error: TRANSLATION_API_KEY environment variable is required');
  process.exit(1);
}

const translatorConfig: TranslatorConfig = {
  provider: TRANSLATION_PROVIDER as 'openai' | 'deepseek' | 'anthropic' | 'google',
  apiKey: API_KEY,
  baseUrl: API_BASE_URL,
  model: TRANSLATION_MODEL
};

const server = new Server(
  {
    name: 'android-translation-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

const TOOLS: Tool[] = [
  {
    name: 'translate_all_modules',
    description: 'Detect changes in all default strings.xml files using git diff and translate them to all supported languages',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: {
          type: 'string',
          description: 'Android project root directory (optional, uses ANDROID_PROJECT_ROOT env var if not provided)'
        }
      }
    }
  },
  {
    name: 'translate_module',
    description: 'Detect changes in a specific module\'s default strings.xml using git diff and translate to all languages',
    inputSchema: {
      type: 'object',
      properties: {
        modulePath: {
          type: 'string',
          description: 'Path to the Android module directory'
        }
      },
      required: ['modulePath']
    }
  },
  {
    name: 'check_changes',
    description: 'Check for uncommitted changes in default strings.xml files without translating',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: {
          type: 'string',
          description: 'Android project root directory (optional)'
        }
      }
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'translate_all_modules') {
      const projectRoot = (args?.projectRoot as string) || DEFAULT_PROJECT_ROOT;
      const manager = new TranslationManager(projectRoot, translatorConfig);
      
      console.error(`Starting translation for all modules in: ${projectRoot}`);
      const summaries = await manager.translateAllModules();
      
      const totalSummary = {
        totalModules: summaries.length,
        totalStringsProcessed: summaries.reduce((sum, s) => sum + s.totalStrings, 0),
        successfulModules: summaries.filter(s => s.success).length,
        failedModules: summaries.filter(s => !s.success).length,
        modules: summaries.map(s => ({
          addedStrings: s.addedStrings,
          modifiedStrings: s.modifiedStrings,
          deletedStrings: s.deletedStrings,
          languages: s.languages.map(l => ({
            language: l.language,
            translatedCount: l.translatedCount,
            errors: l.errors
          }))
        }))
      };
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(totalSummary, null, 2)
          }
        ]
      };
    }
    
    if (name === 'translate_module') {
      const modulePath = args?.modulePath as string;
      if (!modulePath) {
        throw new Error('modulePath is required');
      }
      
      const fullPath = path.isAbsolute(modulePath) 
        ? modulePath 
        : path.join(DEFAULT_PROJECT_ROOT, modulePath);
        
      const manager = new TranslationManager(
        path.dirname(fullPath),
        translatorConfig
      );
      
      console.error(`Starting translation for module: ${fullPath}`);
      const summary = await manager.translateSpecificModule(fullPath);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(summary, null, 2)
          }
        ]
      };
    }
    
    if (name === 'check_changes') {
      const projectRoot = (args?.projectRoot as string) || DEFAULT_PROJECT_ROOT;
      const manager = new TranslationManager(projectRoot, translatorConfig);
      
      const defaultFiles = await manager.findDefaultStringsFiles();
      const changes: any[] = [];
      
      for (const file of defaultFiles) {
        const GitDiffAnalyzer = (await import('./gitDiff.js')).GitDiffAnalyzer;
        const analyzer = new GitDiffAnalyzer(projectRoot);
        const relativePath = path.relative(projectRoot, file);
        const diff = await analyzer.getDefaultStringsChanges(relativePath);
        
        if (diff.added.size > 0 || diff.modified.size > 0 || diff.deleted.size > 0 || diff.orderChanged) {
          changes.push({
            file: relativePath,
            added: Array.from(diff.added.keys()),
            modified: Array.from(diff.modified.keys()),
            deleted: Array.from(diff.deleted),
            orderChanged: diff.orderChanged
          });
        }
      }
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              projectRoot,
              filesWithChanges: changes.length,
              changes
            }, null, 2)
          }
        ]
      };
    }
    
    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Tool execution error:`, error);
    
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${errorMessage}`
        }
      ],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Android Translation MCP Server started');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});