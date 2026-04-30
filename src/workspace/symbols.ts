import * as vscode from 'vscode';
import * as path from 'path';

export interface SymbolResult {
  name: string;
  kind: string;
  path: string;
  line: number;
  containerName?: string;
}

export interface OutlineEntry {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  children?: OutlineEntry[];
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
  [vscode.SymbolKind.File]: 'File',
  [vscode.SymbolKind.Module]: 'Module',
  [vscode.SymbolKind.Namespace]: 'Namespace',
  [vscode.SymbolKind.Package]: 'Package',
  [vscode.SymbolKind.Class]: 'Class',
  [vscode.SymbolKind.Method]: 'Method',
  [vscode.SymbolKind.Property]: 'Property',
  [vscode.SymbolKind.Field]: 'Field',
  [vscode.SymbolKind.Constructor]: 'Constructor',
  [vscode.SymbolKind.Enum]: 'Enum',
  [vscode.SymbolKind.Interface]: 'Interface',
  [vscode.SymbolKind.Function]: 'Function',
  [vscode.SymbolKind.Variable]: 'Variable',
  [vscode.SymbolKind.Constant]: 'Constant',
  [vscode.SymbolKind.String]: 'String',
  [vscode.SymbolKind.Number]: 'Number',
  [vscode.SymbolKind.Boolean]: 'Boolean',
  [vscode.SymbolKind.Array]: 'Array',
  [vscode.SymbolKind.Object]: 'Object',
  [vscode.SymbolKind.Key]: 'Key',
  [vscode.SymbolKind.Null]: 'Null',
  [vscode.SymbolKind.EnumMember]: 'EnumMember',
  [vscode.SymbolKind.Struct]: 'Struct',
  [vscode.SymbolKind.Event]: 'Event',
  [vscode.SymbolKind.Operator]: 'Operator',
  [vscode.SymbolKind.TypeParameter]: 'TypeParameter',
};

function kindName(kind: vscode.SymbolKind): string {
  return SYMBOL_KIND_NAMES[kind] ?? 'Unknown';
}

export class SymbolService {
  async findSymbols(query: string, limit = 30): Promise<SymbolResult[]> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query,
      );

      if (!symbols || symbols.length === 0) {
        return [];
      }

      const root = this.getWorkspaceRoot();
      return symbols.slice(0, limit).map((symbol) => ({
        name: symbol.name,
        kind: kindName(symbol.kind),
        path: root ? path.relative(root, symbol.location.uri.fsPath).replace(/\\/g, '/') : symbol.location.uri.fsPath,
        line: symbol.location.range.start.line + 1,
        containerName: symbol.containerName || undefined,
      }));
    } catch {
      return [];
    }
  }

  async getFileOutline(relativePath: string): Promise<OutlineEntry[]> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return [];
    }

    const uri = vscode.Uri.file(path.resolve(root, relativePath));

    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      );

      if (!symbols || symbols.length === 0) {
        return [];
      }

      return this.flattenSymbols(symbols);
    } catch {
      return [];
    }
  }

  async findSymbolFiles(query: string): Promise<string[]> {
    const symbols = await this.findSymbols(query, 50);
    const seen = new Set<string>();
    return symbols
      .map((symbol) => symbol.path)
      .filter((filePath) => {
        if (seen.has(filePath)) return false;
        seen.add(filePath);
        return true;
      });
  }

  private flattenSymbols(symbols: vscode.DocumentSymbol[], depth = 0): OutlineEntry[] {
    const entries: OutlineEntry[] = [];
    for (const symbol of symbols) {
      const entry: OutlineEntry = {
        name: symbol.name,
        kind: kindName(symbol.kind),
        startLine: symbol.range.start.line + 1,
        endLine: symbol.range.end.line + 1,
      };

      if (symbol.children && symbol.children.length > 0 && depth < 3) {
        entry.children = this.flattenSymbols(symbol.children, depth + 1);
      }

      entries.push(entry);
    }
    return entries;
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
}
