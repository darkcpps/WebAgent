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
  private static readonly READ_FILE_DEFAULT_LIMIT_LINES = 250;
  private static readonly READ_FILE_MAX_CHARS = 30000;

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
    const summary = this.buildActionSummary(action);
    const preview = this.buildPreview(action);
    const decision = this.safety.evaluate(action);

    this.sessions.pushAction(sessionId, {
      id: actionId,
      type: action.type,
      summary,
      status: 'pending',
      requiresApproval: decision.requiresApproval,
      preview,
    });
    this.updateLatestAssistantToolStatus(sessionId, `${summary}...`);

    if (!decision.allowed) {
      this.updateLatestAssistantToolStatus(sessionId, `Blocked ${summary}.`);
      this.sessions.appendLog(sessionId, {
        level: 'error',
        source: 'agent',
        message: `Blocked ${summary}. ${decision.reason ?? 'Not allowed by safety policy.'}`,
      });
      this.sessions.updateAction(sessionId, actionId, { status: 'error', result: decision.reason ?? 'Action blocked.' });
      return { done: false, message: `Blocked action ${action.type}: ${decision.reason ?? 'Not allowed.'}` };
    }

    if (decision.requiresApproval) {
      this.updateLatestAssistantToolStatus(sessionId, `Awaiting approval for ${summary}...`);
      this.sessions.appendLog(sessionId, {
        level: 'info',
        source: 'agent',
        message: `Awaiting approval for ${summary}...`,
      });
      this.sessions.setStatus(sessionId, 'waiting-approval');
      this.sessions.setApprovalRequest(sessionId, {
        actionId,
        type: action.type,
        summary,
        preview,
      });

      const approved = await this.approvals.request(actionId);
      this.sessions.setApprovalRequest(sessionId, undefined);
      this.sessions.setStatus(sessionId, 'running');
      this.sessions.updateAction(sessionId, actionId, { status: approved ? 'approved' : 'rejected' });

      if (!approved) {
        this.updateLatestAssistantToolStatus(sessionId, `Rejected ${summary}.`);
        this.sessions.appendLog(sessionId, {
          level: 'warning',
          source: 'agent',
          message: `Rejected ${summary}.`,
        });
        return { done: false, message: `User rejected action ${action.type}.` };
      }
    }

    this.sessions.updateAction(sessionId, actionId, { status: 'running' });
    this.updateLatestAssistantToolStatus(sessionId, `${summary}...`);
    this.sessions.appendLog(sessionId, {
      level: 'info',
      source: 'agent',
      message: `${summary}...`,
    });

    try {
      const result = await this.run(action);
      this.sessions.updateAction(sessionId, actionId, { status: 'done', result: truncate(result, 1000) });
      this.updateLatestAssistantToolStatus(sessionId, `Done ${summary}.`);
      this.sessions.appendLog(sessionId, {
        level: 'success',
        source: 'agent',
        message: `Done ${summary}.`,
      });
      return {
        done: action.type === 'finish',
        message: result,
      };
    } catch (error) {
      const message = (error as Error).message;
      this.sessions.updateAction(sessionId, actionId, { status: 'error', result: message });
      this.updateLatestAssistantToolStatus(sessionId, `Failed ${summary}: ${truncate(message, 220)}`);
      this.sessions.appendLog(sessionId, {
        level: 'error',
        source: 'agent',
        message: `Failed ${summary}: ${truncate(message, 220)}`,
      });
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
        const lines = content.split(/\r?\n/);
        const totalLines = lines.length;
        const requestedStartLine = action.startLine ?? 1;
        const startLine = Math.min(Math.max(requestedStartLine, 1), Math.max(totalLines, 1));
        const limit = action.limit ?? ActionExecutor.READ_FILE_DEFAULT_LIMIT_LINES;
        const endLine = Math.min(startLine + limit - 1, totalLines);
        const selectedLines = lines.slice(startLine - 1, endLine);
        let body = selectedLines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
        let charTruncated = false;

        if (body.length > ActionExecutor.READ_FILE_MAX_CHARS) {
          body = body.slice(0, ActionExecutor.READ_FILE_MAX_CHARS);
          charTruncated = true;
        }

        const nextStartLine = endLine < totalLines ? endLine + 1 : undefined;
        const parts = [
          `Read ${action.path} lines ${startLine}-${endLine} of ${totalLines} (${content.length} chars total).`,
        ];

        if (nextStartLine) {
          parts.push(`More content is available. Continue with {"type":"read_file","path":"${action.path}","startLine":${nextStartLine},"limit":${limit}}.`);
        }

        if (charTruncated) {
          parts.push('This window was character-truncated. Retry with a smaller limit.');
        }

        parts.push('', body);
        return parts.join('\n');
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

          if (!action.oldString) {
            throw new Error('edit_file oldString must not be empty.');
          }

          if (action.oldString === action.newString) {
            throw new Error('edit_file oldString and newString must differ.');
          }

          const replacement = this.resolveReplacement(current, action.oldString, action.newString, Boolean(action.replaceAll));
          next = replacement.next;
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
        return action.startLine || action.limit
          ? `${action.path} lines ${action.startLine ?? 1}-${action.limit ? (action.startLine ?? 1) + action.limit - 1 : 'default'}`
          : action.path;
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

  private buildActionSummary(action: AgentAction): string {
    const requestedSummary = action.summary?.trim();
    const withRequestedSummary = (base: string): string =>
      requestedSummary ? `${base} - ${truncate(requestedSummary, 100)}` : base;

    switch (action.type) {
      case 'list_files':
        return withRequestedSummary('Listing files');
      case 'read_file':
        return withRequestedSummary(
          action.startLine || action.limit
            ? `Reading ${action.path}:${action.startLine ?? 1}${action.limit ? `+${action.limit}` : ''}`
            : `Reading ${action.path}`,
        );
      case 'search_files':
        return withRequestedSummary(`Searching "${truncate(action.query, 80)}"`);
      case 'edit_file':
        return withRequestedSummary(`Writing ${action.path}`);
      case 'create_file':
        return withRequestedSummary(`Writing ${action.path}`);
      case 'delete_file':
        return withRequestedSummary(`Deleting ${action.path}`);
      case 'rename_file':
        return withRequestedSummary(`Renaming ${action.fromPath} -> ${action.toPath}`);
      case 'run_command':
        return withRequestedSummary(`Running command ${truncate(action.command, 80)}`);
      case 'get_git_diff':
        return withRequestedSummary('Reading git diff');
      case 'ask_user':
        return withRequestedSummary('Asking for your input');
      case 'finish':
        return withRequestedSummary('Finalizing response');
      default:
        return requestedSummary || 'Running action';
    }
  }

  private updateLatestAssistantToolStatus(sessionId: string, content: string): void {
    void sessionId;
    void content;
  }

  private resolveReplacement(
    current: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
  ): { next: string; target: string; count: number } {
    const variants = this.buildReplacementVariants(current, oldString, newString);
    const ambiguousCounts: number[] = [];

    for (const variant of variants) {
      const count = this.countOccurrences(current, variant.oldString);
      if (count === 0) {
        continue;
      }

      if (!replaceAll && count > 1) {
        ambiguousCounts.push(count);
        continue;
      }

      const next = replaceAll
        ? current.split(variant.oldString).join(variant.newString)
        : current.replace(variant.oldString, variant.newString);
      return { next, target: variant.oldString, count };
    }

    if (ambiguousCounts.length > 0) {
      const count = Math.max(...ambiguousCounts);
      throw new Error(`edit_file matched ${count} occurrences; set replaceAll=true or provide more specific text.`);
    }

    throw new Error(
      'edit_file target text not found. Tried exact text plus common provider repairs for escaped newlines, escaped quotes, read_file line prefixes, and CRLF/LF differences.',
    );
  }

  private buildReplacementVariants(
    current: string,
    oldString: string,
    newString: string,
  ): Array<{ oldString: string; newString: string }> {
    const variants: Array<{ oldString: string; newString: string }> = [];
    const add = (oldValue: string, newValue: string): void => {
      if (!oldValue) {
        return;
      }
      if (!variants.some((variant) => variant.oldString === oldValue && variant.newString === newValue)) {
        variants.push({ oldString: oldValue, newString: newValue });
      }
    };

    const basePairs = [
      { oldValue: oldString, newValue: newString },
      { oldValue: this.decodeProviderEscapes(oldString), newValue: this.decodeProviderEscapes(newString) },
      { oldValue: this.stripReadLinePrefixes(oldString), newValue: this.stripReadLinePrefixes(newString) },
      {
        oldValue: this.stripReadLinePrefixes(this.decodeProviderEscapes(oldString)),
        newValue: this.stripReadLinePrefixes(this.decodeProviderEscapes(newString)),
      },
    ];

    for (const pair of basePairs) {
      add(pair.oldValue, pair.newValue);
      add(this.toLf(pair.oldValue), this.toLf(pair.newValue));
      if (current.includes('\r\n')) {
        add(this.toCrlf(pair.oldValue), this.toCrlf(pair.newValue));
      }
    }

    return variants;
  }

  private decodeProviderEscapes(value: string): string {
    return value
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"');
  }

  private stripReadLinePrefixes(value: string): string {
    const lines = value.split(/\r?\n/);
    const prefixedCount = lines.filter((line) => /^\s*\d+:\s?/.test(line)).length;
    if (prefixedCount === 0) {
      return value;
    }
    return lines.map((line) => line.replace(/^\s*\d+:\s?/, '')).join('\n');
  }

  private toLf(value: string): string {
    return value.replace(/\r\n/g, '\n');
  }

  private toCrlf(value: string): string {
    return this.toLf(value).replace(/\n/g, '\r\n');
  }

  private countOccurrences(value: string, needle: string): number {
    if (!needle) {
      return 0;
    }
    return value.split(needle).length - 1;
  }
}
