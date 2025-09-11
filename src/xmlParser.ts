import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface StringResource {
  name: string;
  value: string;
  translatable?: boolean;
}

export interface StringsXML {
  resources: {
    string?: Array<{
      '@_name': string;
      '@_translatable'?: string;
      '#text'?: string;
    }> | {
      '@_name': string;
      '@_translatable'?: string;
      '#text'?: string;
    };
  };
}

export class AndroidXMLParser {
  private parser: XMLParser;
  private builder: XMLBuilder;

  constructor() {
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      preserveOrder: false,
      trimValues: true,
      parseAttributeValue: true
    });

    this.builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      format: true,
      indentBy: '    ',
      suppressEmptyNode: false
    });
  }

  async parseStringsXML(filePath: string): Promise<Map<string, StringResource>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const result = this.parser.parse(content) as StringsXML;
      
      const stringsMap = new Map<string, StringResource>();
      
      if (!result.resources) {
        return stringsMap;
      }

      const strings = result.resources.string;
      if (!strings) {
        return stringsMap;
      }

      const stringArray = Array.isArray(strings) ? strings : [strings];
      
      for (const str of stringArray) {
        const name = str['@_name'];
        const value = str['#text'] || '';
        const translatable = str['@_translatable'] !== 'false';
        
        if (name) {
          stringsMap.set(name, {
            name,
            value,
            translatable
          });
        }
      }
      
      return stringsMap;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map();
      }
      throw error;
    }
  }

  async writeStringsXML(filePath: string, strings: Map<string, StringResource>): Promise<void> {
    const stringArray = Array.from(strings.values()).map(str => {
      const obj: any = {
        '@_name': str.name,
        '#text': str.value
      };
      
      if (str.translatable === false) {
        obj['@_translatable'] = 'false';
      }
      
      return obj;
    });

    const xmlObj: StringsXML = {
      resources: {
        string: stringArray.length > 0 ? stringArray : undefined
      }
    };

    let xmlContent = this.builder.build(xmlObj);
    xmlContent = '<?xml version="1.0" encoding="utf-8"?>\n' + xmlContent;
    
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, xmlContent, 'utf-8');
  }

  async mergeTranslations(
    targetPath: string,
    newTranslations: Map<string, string>
  ): Promise<void> {
    const existingStrings = await this.parseStringsXML(targetPath);
    
    for (const [name, value] of newTranslations) {
      const existing = existingStrings.get(name);
      if (existing && existing.translatable !== false) {
        existing.value = value;
      } else if (!existing) {
        existingStrings.set(name, {
          name,
          value,
          translatable: true
        });
      }
    }
    
    await this.writeStringsXML(targetPath, existingStrings);
  }
}