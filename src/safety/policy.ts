import * as path from 'path';
import * as vscode from 'vscode';
import type { ApprovalMode } from '../shared/types';
import type { AgentAction } from '../agent/protocol';

const SENSITIVE_PATH_PATTERNS = [
  /^\.env(\.|$)/,
  /secrets?/i,
  /id_rsa/i,
  /deploy/i,
  /production/i,
  /terraform/i,
  /\.github\/workflows/i,
];

const DANGEROUS_COMMAND_PATTERNS = [
  /rm\s+-rf/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-fd/i,
  /del\s+\/s/i,
  /shutdown/i,
  /reboot/i,
  /mkfs/i,
  /format\s+/i,
  /dd\s+if=/i,
];

export interface SafetyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
}

export class SafetyPolicy {
  constructor(private readonly configuration: vscode.WorkspaceConfiguration) {}

  get approvalMode(): ApprovalMode {
    return this.configuration.get<ApprovalMode>('approvalMode', 'ask-before-action');
  }

  evaluate(action: AgentAction): SafetyDecision {
    if (this.approvalMode === 'view-only' && !this.isReadOnlyAction(action)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: 'Approval mode is set to view-only.',
      };
    }

    const riskyPath = this.getRiskyPath(action);
    if (riskyPath) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: `Sensitive path detected: ${riskyPath}`,
      };
    }

    if (action.type === 'run_command' && DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(action.command))) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Blocked dangerous command: ${action.command}`,
      };
    }

    if (action.type === 'delete_file' || action.type === 'rename_file') {
      return {
        allowed: true,
        requiresApproval: true,
      };
    }

    if (action.type === 'run_command') {
      return {
        allowed: true,
        requiresApproval: this.approvalMode !== 'auto-apply-safe-edits',
      };
    }

    if (action.type === 'edit_file' || action.type === 'create_file') {
      return {
        allowed: true,
        requiresApproval: this.approvalMode === 'ask-before-action',
      };
    }

    return {
      allowed: true,
      requiresApproval: false,
    };
  }

  ensureInsideWorkspace(workspaceRoot: string, candidatePath: string): string | undefined {
    const normalized = path.resolve(workspaceRoot, candidatePath);
    const relative = path.relative(workspaceRoot, normalized);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return undefined;
    }
    return normalized;
  }

  private isReadOnlyAction(action: AgentAction): boolean {
    return ['list_files', 'read_file', 'search_files', 'get_git_diff', 'ask_user', 'finish'].includes(action.type);
  }

  private getRiskyPath(action: AgentAction): string | undefined {
    const filePath =
      'path' in action && typeof action.path === 'string'
        ? action.path
        : action.type === 'rename_file'
          ? `${action.fromPath} -> ${action.toPath}`
          : undefined;

    if (!filePath) {
      return undefined;
    }

    return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(filePath)) ? filePath : undefined;
  }
}
