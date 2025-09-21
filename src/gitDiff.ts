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
  private repoRootPromise?: Promise<string>;

  constructor(workingDir: string) {
    this.workingDir = path.resolve(workingDir);
    this.git = simpleGit(this.workingDir);
    this.xmlParser = new AndroidXMLParser();
  }

  private normalizePath(filePath: string): string {
    return filePath.split(path.sep).join('/');
  }

  private async getRepoRoot(): Promise<string> {
    if (!this.repoRootPromise) {
      this.repoRootPromise = this.git
        .revparse(['--show-toplevel'])
        .then(root => path.resolve(root.trim()))
        .catch(() => this.workingDir);
    }
    return this.repoRootPromise;
  }

  private async resolvePaths(filePath: string): Promise<{
    absolutePath: string;
    gitRelativePath: string;
    workingRelativePath: string;
  }> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workingDir, filePath);

    const repoRoot = await this.getRepoRoot();
    let gitRelativePath = path.relative(repoRoot, absolutePath);
    const workingRelativePath = path.relative(this.workingDir, absolutePath);

    gitRelativePath = this.normalizePath(gitRelativePath);
    const normalizedWorkingRelative = this.normalizePath(workingRelativePath);

    if (!gitRelativePath || gitRelativePath.startsWith('..')) {
      throw new Error(`File is outside of git repository: ${absolutePath}`);
    }

    return {
      absolutePath,
      gitRelativePath,
      workingRelativePath: normalizedWorkingRelative
    };
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
      const {
        absolutePath,
        gitRelativePath,
        workingRelativePath
      } = await this.resolvePaths(defaultStringsPath);

      const notAdded = status.not_added.map(p => this.normalizePath(p));
      const created = status.created.map(p => this.normalizePath(p));
      const isTracked = !notAdded.includes(workingRelativePath) && !created.includes(workingRelativePath);

      if (!isTracked) {
        const currentStrings = await this.xmlParser.parseStringsXML(absolutePath);
        for (const [name, resource] of currentStrings) {
          if (resource.translatable !== false) {
            diffResult.added.set(name, resource.value);
          }
        }
        return diffResult;
      }

      const currentStrings = await this.xmlParser.parseStringsXML(absolutePath);
      diffResult.currentOrder = Array.from(currentStrings.keys());
      
      const headContent = await this.git.show(['HEAD:' + gitRelativePath]).catch(() => '');
      
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
    const { workingRelativePath } = await this.resolvePaths(filePath);
    const status = await this.git.status();
    const modified = status.modified.map(p => this.normalizePath(p));
    const notAdded = status.not_added.map(p => this.normalizePath(p));
    const created = status.created.map(p => this.normalizePath(p));

    return modified.includes(workingRelativePath) ||
           notAdded.includes(workingRelativePath) ||
           created.includes(workingRelativePath);
  }
}
