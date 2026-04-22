import * as vscode from 'vscode';
import type { ApprovalManager } from '../safety/approvalManager';
import { SafetyPolicy } from '../safety/policy';
import type { SessionStore } from '../storage/sessionStore';
import { TerminalRunner } from '../terminal/runner';
import { createId, truncate } from '../shared/utils';
import { DiffPreviewService } from '../services/diffPreviewService';
import { WorkspaceFilesService } from '../workspace/files';
import { GitService } from '../workspace/git';
import type { AgentAction } from './protocol';

export interface ExecutionResult {
  done: boolean;
  message: string;
}

export class ActionExecutor {
  constructor(
    private readonly files: WorkspaceFilesService,
    private readonly git: GitService,
    private readonly safety: SafetyPolicy,
    private readonly approvals: ApprovalManager,
    private readonly sessions: SessionStore,
    private readonly diffPreview: DiffPreviewService,
    private readonly terminal: TerminalRunner,
  ) {}

  async execute(sessionId: string, action: AgentAction): Promise<ExecutionResult> {
    const actionId = createId('action');
    const preview = this.buildPreview(action);
    const decision = this.safety.evaluate(action);

    this.sessions.pushAction(sessionId, {
      id: actionId,
      type: action.type,
      summary: action.summary || action.type,
      status: 'pending',
      requiresApproval: decision.requiresApproval,
      preview,
    });

    if (!decision.allowed) {
      this.sessions.updateAction(sessionId, actionId, { status: 'error', result: decision.reason ?? 'Action blocked.' });
      return { done: false, message: `Blocked action ${action.type}: ${decision.reason ?? 'Not allowed.'}` };
    }

    if (decision.requiresApproval) {
      this.sessions.setStatus(sessionId, 'waiting-approval');
      this.sessions.setApprovalRequest(sessionId, {
        actionId,
        type: action.type,
        summary: action.summary || action.type,
        preview,
      });

      const approved = await this.approvals.request(actionId);
      this.sessions.setApprovalRequest(sessionId, undefined);
      this.sessions.setStatus(sessionId, 'running');
      this.sessions.updateAction(sessionId, actionId, { status: approved ? 'approved' : 'rejected' });

      if (!approved) {
        return { done: false, message: `User rejected action ${action.type}.` };
      }
    }

    this.sessions.updateAction(sessionId, actionId, { status: 'running' });

    try {
      const result = await this.run(action);
      this.sessions.updateAction(sessionId, actionId, { status: 'done', result: truncate(result, 1000) });
      return {
        done: action.type === 'finish',
        message: result,
      };
    } catch (error) {
      const message = (error as Error).message;
      this.sessions.updateAction(sessionId, actionId, { status: 'error', result: message });
      return {
        done: false,
        message: `Action failed: ${message}`,
      };
    }
  }

  private async run(action: AgentAction): Promise<string> {
    switch (action.type) {
      case 'list_files': {
        const files = await this.files.listFiles(action.limit);
        return `Files:\n${files.join('\n')}`;
      }
      case 'read_file': {
        const content = await this.files.readFile(action.path);
        return `Read ${action.path}:\n${truncate(content, 8000)}`;
      }
      case 'search_files': {
        const results = await this.files.searchFiles(action.query, action.limit ?? 20);
        return JSON.stringify(results, null, 2);
      }
      case 'edit_file': {
        const current = await this.files.readFile(action.path);
        let next = action.content;

        if (typeof next !== 'string') {
          if (typeof action.oldString !== 'string' || typeof action.newString !== 'string') {
            throw new Error('edit_file missing content and old/new replacement strings.');
          }

          if (action.oldString === action.newString) {
            throw new Error('edit_file oldString and newString must differ.');
          }

          const occurrenceCount = (current.match(new RegExp(this.escapeRegex(action.oldString), 'g')) || []).length;
          if (occurrenceCount === 0) {
            throw new Error(`edit_file target text not found in ${action.path}.`);
          }

          if (!action.replaceAll && occurrenceCount > 1) {
            throw new Error(
              `edit_file matched ${occurrenceCount} occurrences in ${action.path}; set replaceAll=true or provide more specific text.`,
            );
          }

          next = action.replaceAll
            ? current.split(action.oldString).join(action.newString)
            : current.replace(action.oldString, action.newString);
        }

        await this.diffPreview.showFileReplacement(action.path, current, next);
        await this.files.writeFile(action.path, next);
        return `Updated ${action.path}`;
      }
      case 'create_file': {
        await this.files.writeFile(action.path, action.content);
        return `Created ${action.path}`;
      }
      case 'delete_file': {
        await this.files.deleteFile(action.path);
        return `Deleted ${action.path}`;
      }
      case 'rename_file': {
        await this.files.renameFile(action.fromPath, action.toPath);
        return `Renamed ${action.fromPath} -> ${action.toPath}`;
      }
      case 'run_command': {
        const result = await this.terminal.run(action.command);
        return [`Exit code: ${result.exitCode ?? 'unknown'}`, result.stdout, result.stderr].filter(Boolean).join('\n');
      }
      case 'get_git_diff': {
        return await this.git.getDiff();
      }
      case 'ask_user': {
        return action.question;
      }
      case 'finish': {
        return action.result;
      }
    }
  }

  private buildPreview(action: AgentAction): string {
    switch (action.type) {
      case 'edit_file':
      case 'create_file':
        if (action.type === 'create_file') {
          return `${action.path}\n\n${truncate(action.content, 1500)}`;
        }
        if (typeof action.content === 'string') {
          return `${action.path}\n\n${truncate(action.content, 1500)}`;
        }
        return `${action.path}\n\nreplace: ${truncate(action.oldString ?? '', 400)}\nwith: ${truncate(action.newString ?? '', 400)}`;
      case 'run_command':
        return action.command;
      case 'rename_file':
        return `${action.fromPath} -> ${action.toPath}`;
      case 'read_file':
      case 'delete_file':
        return action.path;
      case 'search_files':
        return action.query;
      case 'finish':
        return action.result;
      default:
        return action.summary || action.type;
    }
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
