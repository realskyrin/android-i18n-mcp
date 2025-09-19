import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import { AndroidXMLParser, StringResource } from './xmlParser.js';

export interface DiffResult {
  added: Map<string, string>;
  modified: Map<string, string>;
  deleted: Set<string>;
  orderChanged: boolean;
  currentOrder: string[];
}

export class GitDiffAnalyzer {
  private git: SimpleGit;
  private xmlParser: AndroidXMLParser;
  private workingDir: string;

  constructor(workingDir: string) {
    this.workingDir = path.resolve(workingDir);
    this.git = simpleGit(this.workingDir);
    this.xmlParser = new AndroidXMLParser();
  }

  async getDefaultStringsChanges(defaultStringsPath: string): Promise<DiffResult> {
    const diffResult: DiffResult = {
      added: new Map(),
      modified: new Map(),
      deleted: new Set(),
      orderChanged: false,
      currentOrder: []
    };

    try {
      const status = await this.git.status();
      const isTracked = !status.not_added.includes(defaultStringsPath);

      if (!isTracked) {
        const absolutePath = path.isAbsolute(defaultStringsPath)
          ? defaultStringsPath
          : path.join(this.workingDir, defaultStringsPath);
        const currentStrings = await this.xmlParser.parseStringsXML(absolutePath);
        for (const [name, resource] of currentStrings) {
          if (resource.translatable !== false) {
            diffResult.added.set(name, resource.value);
          }
        }
        return diffResult;
      }

      const absolutePath = path.isAbsolute(defaultStringsPath)
        ? defaultStringsPath
        : path.join(this.workingDir, defaultStringsPath);
      const currentStrings = await this.xmlParser.parseStringsXML(absolutePath);
      diffResult.currentOrder = Array.from(currentStrings.keys());
      
      const headContent = await this.git.show(['HEAD:' + defaultStringsPath]).catch(() => '');
      
      const previousStrings = new Map<string, StringResource>();
      let previousOrder: string[] = [];
      if (headContent) {
        const tempPath = `/tmp/temp_strings_${Date.now()}.xml`;
        const fs = await import('fs/promises');
        await fs.writeFile(tempPath, headContent, 'utf-8');
        const parsed = await this.xmlParser.parseStringsXML(tempPath);
        await fs.unlink(tempPath);
        
        for (const [name, resource] of parsed) {
          previousStrings.set(name, resource);
        }
        previousOrder = Array.from(parsed.keys());
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

      // Check if the order has changed
      if (previousOrder.length > 0) {
        const currentOrderFiltered = diffResult.currentOrder.filter(key => previousStrings.has(key));
        const previousOrderFiltered = previousOrder.filter(key => currentStrings.has(key));
        
        if (currentOrderFiltered.length === previousOrderFiltered.length) {
          for (let i = 0; i < currentOrderFiltered.length; i++) {
            if (currentOrderFiltered[i] !== previousOrderFiltered[i]) {
              diffResult.orderChanged = true;
              break;
            }
          }
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
