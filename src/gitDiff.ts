import simpleGit, { SimpleGit } from 'simple-git';
import { AndroidXMLParser, StringResource } from './xmlParser.js';

export interface DiffResult {
  added: Map<string, string>;
  modified: Map<string, string>;
  deleted: Set<string>;
}

export class GitDiffAnalyzer {
  private git: SimpleGit;
  private xmlParser: AndroidXMLParser;

  constructor(workingDir: string) {
    this.git = simpleGit(workingDir);
    this.xmlParser = new AndroidXMLParser();
  }

  async getDefaultStringsChanges(defaultStringsPath: string): Promise<DiffResult> {
    const diffResult: DiffResult = {
      added: new Map(),
      modified: new Map(),
      deleted: new Set()
    };

    try {
      const status = await this.git.status();
      const isTracked = !status.not_added.includes(defaultStringsPath);
      
      if (!isTracked) {
        const currentStrings = await this.xmlParser.parseStringsXML(defaultStringsPath);
        for (const [name, resource] of currentStrings) {
          if (resource.translatable !== false) {
            diffResult.added.set(name, resource.value);
          }
        }
        return diffResult;
      }

      const currentStrings = await this.xmlParser.parseStringsXML(defaultStringsPath);
      
      const headContent = await this.git.show(['HEAD:' + defaultStringsPath]).catch(() => '');
      
      const previousStrings = new Map<string, StringResource>();
      if (headContent) {
        const tempPath = `/tmp/temp_strings_${Date.now()}.xml`;
        const fs = await import('fs/promises');
        await fs.writeFile(tempPath, headContent, 'utf-8');
        const parsed = await this.xmlParser.parseStringsXML(tempPath);
        await fs.unlink(tempPath);
        
        for (const [name, resource] of parsed) {
          previousStrings.set(name, resource);
        }
      }

      for (const [name, currentResource] of currentStrings) {
        if (currentResource.translatable === false) continue;
        
        const previousResource = previousStrings.get(name);
        
        if (!previousResource) {
          diffResult.added.set(name, currentResource.value);
        } else if (previousResource.value !== currentResource.value) {
          diffResult.modified.set(name, currentResource.value);
        }
      }

      for (const [name, previousResource] of previousStrings) {
        if (previousResource.translatable === false) continue;
        
        if (!currentStrings.has(name)) {
          diffResult.deleted.add(name);
        }
      }

    } catch (error) {
      console.error('Error analyzing git diff:', error);
      throw error;
    }

    return diffResult;
  }

  async hasUncommittedChanges(filePath: string): Promise<boolean> {
    const status = await this.git.status();
    return status.modified.includes(filePath) || 
           status.not_added.includes(filePath) ||
           status.created.includes(filePath);
  }
}