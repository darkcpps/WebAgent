import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export type CodebaseTier = 'small' | 'medium' | 'large' | 'massive';

export interface CodebaseProfile {
  tier: CodebaseTier;
  fileCount: number;
  isGitRepo: boolean;
  detectedAt: number;

  maxFileScan: number;
  searchScanLimit: number;
  contextFilesBudgetKb: number;
  contextRefreshInterval: number;
  useCompactPrompts: boolean;
  useLargeRepoGuidance: boolean;
  toolResultMaxChars: number;
  toolResultItemMaxChars: number;
  ledgerBudgetChars: number;
}

const TIER_PROFILES: Record<CodebaseTier, Omit<CodebaseProfile, 'tier' | 'fileCount' | 'isGitRepo' | 'detectedAt'>> = {
  small: {
    maxFileScan: 200,
    searchScanLimit: 80,
    contextFilesBudgetKb: 40,
    contextRefreshInterval: 0,
    useCompactPrompts: false,
    useLargeRepoGuidance: false,
    toolResultMaxChars: 24000,
    toolResultItemMaxChars: 3000,
    ledgerBudgetChars: 9000,
  },
  medium: {
    maxFileScan: 500,
    searchScanLimit: 200,
    contextFilesBudgetKb: 40,
    contextRefreshInterval: 8,
    useCompactPrompts: false,
    useLargeRepoGuidance: false,
    toolResultMaxChars: 32000,
    toolResultItemMaxChars: 4000,
    ledgerBudgetChars: 11000,
  },
  large: {
    maxFileScan: 2000,
    searchScanLimit: 500,
    contextFilesBudgetKb: 60,
    contextRefreshInterval: 5,
    useCompactPrompts: true,
    useLargeRepoGuidance: true,
    toolResultMaxChars: 48000,
    toolResultItemMaxChars: 5000,
    ledgerBudgetChars: 14000,
  },
  massive: {
    maxFileScan: 5000,
    searchScanLimit: 1000,
    contextFilesBudgetKb: 80,
    contextRefreshInterval: 3,
    useCompactPrompts: true,
    useLargeRepoGuidance: true,
    toolResultMaxChars: 48000,
    toolResultItemMaxChars: 5000,
    ledgerBudgetChars: 14000,
  },
};

function classifyTier(fileCount: number): CodebaseTier {
  if (fileCount < 200) return 'small';
  if (fileCount < 2000) return 'medium';
  if (fileCount < 20000) return 'large';
  return 'massive';
}

function buildProfile(tier: CodebaseTier, fileCount: number, isGitRepo: boolean): CodebaseProfile {
  return {
    tier,
    fileCount,
    isGitRepo,
    detectedAt: Date.now(),
    ...TIER_PROFILES[tier],
  };
}

export class CodebaseTierDetector {
  private cached: CodebaseProfile | undefined;

  async detect(forceRefresh = false): Promise<CodebaseProfile> {
    if (this.cached && !forceRefresh) {
      return this.cached;
    }

    const root = this.getWorkspaceRoot();
    if (!root) {
      this.cached = buildProfile('small', 0, false);
      return this.cached;
    }

    const gitResult = await this.tryGitCount(root);
    if (gitResult !== undefined) {
      const tier = this.applyOverride(classifyTier(gitResult));
      this.cached = buildProfile(tier, gitResult, true);
      return this.cached;
    }

    const vsCodeCount = await this.tryVsCodeCount();
    const tier = this.applyOverride(classifyTier(vsCodeCount));
    this.cached = buildProfile(tier, vsCodeCount, false);
    return this.cached;
  }

  getCached(): CodebaseProfile | undefined {
    return this.cached;
  }

  private async tryGitCount(root: string): Promise<number | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files'], { timeout: 3000, maxBuffer: 10 * 1024 * 1024 });
      const lines = stdout.trim().split('\n').filter(Boolean);
      return lines.length;
    } catch {
      return undefined;
    }
  }

  private async tryVsCodeCount(): Promise<number> {
    const probeLimit = 2001;
    const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**}', probeLimit);
    return files.length;
  }

  private applyOverride(detected: CodebaseTier): CodebaseTier {
    const config = vscode.workspace.getConfiguration('webagentCode');
    const override = config.get<string>('codebaseTier', 'auto');
    if (override && override !== 'auto') {
      const valid: CodebaseTier[] = ['small', 'medium', 'large', 'massive'];
      if (valid.includes(override as CodebaseTier)) {
        return override as CodebaseTier;
      }
    }
    return detected;
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
}
