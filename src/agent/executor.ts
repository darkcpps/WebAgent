import * as vscode from 'vscode';
import type { ApprovalManager } from '../safety/approvalManager';
import { SafetyPolicy } from '../safety/policy';
import type { SessionStore } from '../storage/sessionStore';
import { TerminalRunner } from '../terminal/runner';
import { createId, truncate } from '../shared/utils';
import { DiffPreviewService } from '../services/diffPreviewService';
import { WorkspaceFilesService, type FileReadWindow } from '../workspace/files';
import { GitService } from '../workspace/git';
import { McpManager } from '../services/mcpManager';
import type { AgentAction } from './protocol';

export interface ExecutionResult {
  done: boolean;
  message: string;
}

interface McpSchemaValidationResult {
  ok: boolean;
  value: Record<string, unknown>;
  errors: string[];
}

interface PreparedMcpToolCall {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  schemaHint: string;
}

interface McpCallActionShape {
  type?: 'call_mcp_tool';
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
}

interface McpResolveActionShape {
  type?: 'resolve_mcp_intent';
  server?: string;
  intent?: string;
  knownArguments?: Record<string, unknown>;
}

interface McpToolCandidate {
  server: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
  score: number;
  reasons: string[];
}

export class ActionExecutor {
  private static readonly READ_FILE_DEFAULT_LIMIT_LINES = 250;
  private readonly sessionReads = new Map<string, Set<string>>();

  constructor(
    private readonly files: WorkspaceFilesService,
    private readonly git: GitService,
    private readonly safety: SafetyPolicy,
    private readonly approvals: ApprovalManager,
    private readonly sessions: SessionStore,
    private readonly diffPreview: DiffPreviewService,
    private readonly terminal: TerminalRunner,
    private readonly mcp?: McpManager,
  ) {}

  async getMcpToolPromptContext(): Promise<string | undefined> {
    if (!this.mcp) {
      return undefined;
    }

    try {
      const tools = await this.mcp.listTools();
      if (tools.length === 0) {
        return undefined;
      }

      return `MCP_TOOL_CATALOG:\n${this.formatMcpToolCatalog(tools)}`;
    } catch (error) {
      return `list_mcp_tools: MCP discovery failed before the first agent round: ${(error as Error).message}`;
    }
  }

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

    if (action.type === 'call_mcp_tool') {
      try {
        await this.prepareMcpToolCall(action);
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

    const preflight = await this.preflight(sessionId, action);
    if (preflight) {
      this.sessions.updateAction(sessionId, actionId, { status: 'error', result: preflight });
      this.updateLatestAssistantToolStatus(sessionId, `Blocked ${summary}.`);
      this.sessions.appendLog(sessionId, {
        level: 'warning',
        source: 'agent',
        message: `Blocked ${summary}: ${truncate(preflight, 220)}`,
      });
      return {
        done: false,
        message: `Action failed: ${preflight}`,
      };
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
      this.recordSuccessfulAction(sessionId, action);
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
        return this.formatReadWindow(await this.files.readFileWindow({
          path: action.path,
          startLine: action.startLine,
          limit: action.limit,
        }));
      }
      case 'search_files': {
        const results = await this.files.searchFiles(action.query, action.limit ?? 20);
        return JSON.stringify(results, null, 2);
      }
      case 'inspect_repo': {
        const inspection = await this.files.inspectRepo(action.query, action.limit);
        const status = await this.git.getStatus().catch(() => 'Git status unavailable');
        const branch = await this.git.getBranch().catch(() => 'unknown');
        return [
          'REPO_INSPECTION:',
          JSON.stringify({ ...inspection, git: { branch, status } }, null, 2),
          '',
          'Use matching/key files as hints only. Read files before relying on their contents or editing.',
        ].join('\n');
      }
      case 'read_many_files': {
        const windows = await Promise.all(action.files.map((file) => this.files.readFileWindow({
          path: file.path,
          startLine: file.startLine,
          limit: file.limit,
        })));
        return windows.map((window) => this.formatReadWindow(window)).join('\n\n---\n\n');
      }
      case 'search_code': {
        const results = await this.files.searchCode(action.query, action.limit ?? 20);
        return JSON.stringify(results, null, 2);
      }
      case 'edit_file': {
        const current = await this.files.readFile(action.path);
        let next = typeof action.content === 'string'
          ? this.normalizeProviderEscapedMultiline(action.content)
          : action.content;

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
      case 'apply_patch': {
        const nextByPath = new Map<string, string>();
        for (const patch of action.patches) {
          const current = nextByPath.get(patch.path) ?? await this.files.readFile(patch.path);
          const replacement = this.resolveReplacement(current, patch.oldString, patch.newString, Boolean(patch.replaceAll));
          nextByPath.set(patch.path, replacement.next);
        }

        for (const [path, next] of nextByPath) {
          const current = await this.files.readFile(path);
          await this.diffPreview.showFileReplacement(path, current, next);
          await this.files.writeFile(path, next);
        }

        return `Applied ${action.patches.length} patch${action.patches.length === 1 ? '' : 'es'} across ${nextByPath.size} file${nextByPath.size === 1 ? '' : 's'}: ${[...nextByPath.keys()].join(', ')}`;
      }
      case 'create_file': {
        await this.files.writeFile(action.path, this.normalizeProviderEscapedMultiline(action.content));
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
      case 'list_mcp_tools': {
        if (!this.mcp) {
          return 'MCP is not available in this extension build.';
        }
        const tools = await this.mcp.listTools();
        if (tools.length === 0) {
          return 'No MCP tools are configured. Add servers to webagentCode.mcp.servers or Codex ~/.codex/config.toml.';
        }

        return this.formatMcpToolList(tools, action.server, action.tool);
      }
      case 'call_mcp_tool': {
        const prepared = await this.prepareMcpToolCall(action);
        let result: unknown;
        try {
          result = await this.mcp!.callTool(prepared.server, prepared.tool, prepared.arguments, action.timeoutMs);
        } catch (error) {
          throw new Error([`MCP tool call failed: ${(error as Error).message}`, prepared.schemaHint].filter(Boolean).join('\n\n'));
        }
        return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      }
      case 'resolve_mcp_intent': {
        return await this.resolveMcpIntent(action);
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
      case 'inspect_repo':
        return action.query ? `Inspect repo for "${truncate(action.query, 120)}"` : 'Inspect repo structure, key files, scripts, and git status';
      case 'read_many_files':
        return action.files
          .map((file) => file.startLine || file.limit
            ? `${file.path}:${file.startLine ?? 1}${file.limit ? `+${file.limit}` : ''}`
            : file.path)
          .join('\n');
      case 'search_code':
        return action.query;
      case 'edit_file':
      case 'create_file':
        if (action.type === 'create_file') {
          return `${action.path}\n\n${truncate(action.content, 1500)}`;
        }
        if (typeof action.content === 'string') {
          return `${action.path}\n\n${truncate(action.content, 1500)}`;
        }
        return `${action.path}\n\nreplace: ${truncate(action.oldString ?? '', 400)}\nwith: ${truncate(action.newString ?? '', 400)}`;
      case 'apply_patch':
        return action.patches
          .map((patch) => `${patch.path}\nreplace: ${truncate(patch.oldString, 300)}\nwith: ${truncate(patch.newString, 300)}`)
          .join('\n\n---\n\n');
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
      case 'list_mcp_tools':
        return action.tool && action.server
          ? `Discover schema for ${action.server}.${action.tool}`
          : action.server
            ? `Discover MCP tools for ${action.server}`
            : 'Discover configured MCP tools';
      case 'call_mcp_tool':
        return `${action.server}.${action.tool}\n\n${truncate(JSON.stringify(action.arguments ?? {}, null, 2), 1500)}`;
      case 'resolve_mcp_intent':
        return `${action.server ? `${action.server}: ` : ''}${truncate(action.intent, 120)}\n\n${truncate(JSON.stringify(action.knownArguments ?? {}, null, 2), 1500)}`;
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
      case 'inspect_repo':
        return withRequestedSummary('Inspecting repo');
      case 'read_file':
        return withRequestedSummary(
          action.startLine || action.limit
            ? `Reading ${action.path}:${action.startLine ?? 1}${action.limit ? `+${action.limit}` : ''}`
            : `Reading ${action.path}`,
        );
      case 'read_many_files':
        return withRequestedSummary(`Reading ${action.files.length} files`);
      case 'search_files':
        return withRequestedSummary(`Searching "${truncate(action.query, 80)}"`);
      case 'search_code':
        return withRequestedSummary(`Searching code "${truncate(action.query, 80)}"`);
      case 'edit_file':
        return withRequestedSummary(`Writing ${action.path}`);
      case 'apply_patch':
        return withRequestedSummary(`Applying ${action.patches.length} patch${action.patches.length === 1 ? '' : 'es'}`);
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
      case 'list_mcp_tools':
        return withRequestedSummary(
          action.tool && action.server
            ? `Listing MCP schema ${action.server}.${action.tool}`
            : action.server
              ? `Listing MCP tools on ${action.server}`
              : 'Listing MCP tools',
        );
      case 'call_mcp_tool':
        return withRequestedSummary(`Calling MCP ${action.server}.${action.tool}`);
      case 'resolve_mcp_intent':
        return withRequestedSummary(`Resolving MCP intent${action.server ? ` on ${action.server}` : ''}`);
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

  private formatReadWindow(window: FileReadWindow): string {
    const nextStartLine = window.endLine < window.totalLines ? window.endLine + 1 : undefined;
    const parts = [
      `Read ${window.path} lines ${window.startLine}-${window.endLine} of ${window.totalLines} (${window.totalChars} chars total).`,
    ];

    if (nextStartLine) {
      parts.push(`More content is available. Continue with {"type":"read_file","path":"${window.path}","startLine":${nextStartLine},"limit":${ActionExecutor.READ_FILE_DEFAULT_LIMIT_LINES}}.`);
    }

    if (window.truncated) {
      parts.push('This window was character-truncated. Retry with a smaller limit.');
    }

    parts.push('', window.content);
    return parts.join('\n');
  }

  private recordSuccessfulAction(sessionId: string, action: AgentAction): void {
    const reads = this.sessionReads.get(sessionId) ?? new Set<string>();
    if (action.type === 'read_file') {
      reads.add(action.path);
    }
    if (action.type === 'read_many_files') {
      for (const file of action.files) {
        reads.add(file.path);
      }
    }
    this.sessionReads.set(sessionId, reads);
  }

  private async preflight(sessionId: string, action: AgentAction): Promise<string | undefined> {
    if (action.type === 'read_many_files') {
      const maxReadBatch = Math.max(1, vscode.workspace.getConfiguration('webagentCode').get<number>('agent.maxReadBatch', 6));
      if (action.files.length > maxReadBatch) {
        return [
          `read_many_files requested ${action.files.length} files, but the configured maximum is ${maxReadBatch}.`,
          `Next valid action: ${JSON.stringify({ type: 'read_many_files', files: action.files.slice(0, maxReadBatch) })}`,
        ].join('\n');
      }
    }

    const unread = this.requiredReadPaths(action).filter((path) => !this.hasRead(sessionId, path));
    if (unread.length > 0) {
      const nextAction = unread.length === 1
        ? { type: 'read_file', path: unread[0], startLine: 1, limit: ActionExecutor.READ_FILE_DEFAULT_LIMIT_LINES }
        : { type: 'read_many_files', files: unread.slice(0, 6).map((path) => ({ path, startLine: 1, limit: ActionExecutor.READ_FILE_DEFAULT_LIMIT_LINES })) };
      return [
        `The agent tried to ${action.type} without reading required file evidence first: ${unread.join(', ')}.`,
        'Read the exact target file(s), then retry the mutation using only observed text.',
        `Next valid action: ${JSON.stringify(nextAction)}`,
      ].join('\n');
    }

    if (action.type === 'run_command') {
      const commandIssue = await this.preflightCommand(action.command);
      if (commandIssue) {
        return commandIssue;
      }
    }

    if (action.type === 'edit_file' && typeof action.content !== 'string') {
      if (typeof action.oldString !== 'string' || typeof action.newString !== 'string') {
        return 'edit_file is missing content and oldString/newString replacement fields. Read the target file and retry with exact observed oldString text.';
      }

      const current = await this.files.readFile(action.path);
      try {
        this.resolveReplacement(current, action.oldString, action.newString, Boolean(action.replaceAll));
      } catch (error) {
        return [
          `edit_file validation failed for ${action.path}: ${(error as Error).message}`,
          'Read the current target window again and retry with exact observed text in oldString.',
          `Next valid action: ${JSON.stringify({ type: 'read_file', path: action.path, startLine: 1, limit: ActionExecutor.READ_FILE_DEFAULT_LIMIT_LINES })}`,
        ].join('\n');
      }
    }

    if (action.type === 'apply_patch') {
      for (const patch of action.patches) {
        const current = await this.files.readFile(patch.path);
        try {
          this.resolveReplacement(current, patch.oldString, patch.newString, Boolean(patch.replaceAll));
        } catch (error) {
          return [
            `Patch validation failed for ${patch.path}: ${(error as Error).message}`,
            'Read the current target window again and retry with exact observed text in oldString.',
            `Next valid action: ${JSON.stringify({ type: 'read_file', path: patch.path, startLine: 1, limit: ActionExecutor.READ_FILE_DEFAULT_LIMIT_LINES })}`,
          ].join('\n');
        }
      }
    }

    return undefined;
  }

  private requiredReadPaths(action: AgentAction): string[] {
    switch (action.type) {
      case 'edit_file':
      case 'delete_file':
        return [action.path];
      case 'rename_file':
        return [action.fromPath];
      case 'apply_patch':
        return [...new Set(action.patches.map((patch) => patch.path))];
      default:
        return [];
    }
  }

  private hasRead(sessionId: string, path: string): boolean {
    return this.sessionReads.get(sessionId)?.has(path) ?? false;
  }

  private async preflightCommand(command: string): Promise<string | undefined> {
    const npmRun = command.match(/(?:^|\s)npm(?:\.cmd)?\s+run\s+([^\s]+)/i);
    if (!npmRun) {
      return undefined;
    }

    const script = npmRun[1];
    const scripts = await this.files.readPackageScripts().catch(() => []);
    if (scripts.length === 0 || scripts.includes(script)) {
      return undefined;
    }

    return [
      `Command references missing package.json script "${script}".`,
      `Available scripts: ${scripts.join(', ') || 'none'}.`,
      'Inspect package.json or choose an existing script before running commands.',
      `Next valid action: ${JSON.stringify({ type: 'read_file', path: 'package.json', startLine: 1, limit: 200 })}`,
    ].join('\n');
  }

  private async buildMcpSchemaHint(server: string, toolName: string): Promise<string | undefined> {
    if (!this.mcp) {
      return undefined;
    }

    try {
      const tools = await this.mcp.listTools();
      const tool = tools.find((entry) => entry.server === server && entry.name === toolName);
      if (!tool) {
        const serverTools = tools
          .filter((entry) => entry.server === server)
          .map((entry) => entry.name)
          .sort();
        return serverTools.length
          ? `Available tools on ${server}: ${serverTools.join(', ')}`
          : undefined;
      }

      return `Expected schema for ${server}.${toolName}:\n${JSON.stringify({
        server: tool.server,
        tool: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }, null, 2)}`;
    } catch {
      return undefined;
    }
  }

  private async prepareMcpToolCall(action: McpCallActionShape): Promise<PreparedMcpToolCall> {
    if (!this.mcp) {
      throw new Error('MCP is not available in this extension build.');
    }
    if (!action.tool) {
      throw new Error('MCP call is missing required "tool". Choose an exact tool name from MCP_TOOL_CATALOG.');
    }

    const allTools = await this.mcp.listTools();
    let serverName = action.server;
    if (!serverName) {
      const matchingTools = allTools.filter(t => t.name === action.tool);
      if (matchingTools.length === 1) {
        serverName = matchingTools[0].server;
      } else if (matchingTools.length > 1) {
        throw new Error(`Tool "${action.tool}" is ambiguous. Specify "server". Available servers for this tool: ${[...new Set(matchingTools.map(t => t.server))].join(', ')}`);
      } else {
        throw new Error(`Tool "${action.tool}" not found on any MCP server. Choose an exact tool name from MCP_TOOL_CATALOG.`);
      }
    }

    const targetTool = allTools.find((tool) => tool.server === serverName && tool.name === action.tool);
    if (!targetTool) {
      throw new Error(this.buildUnknownMcpToolMessage(allTools, serverName, action.tool));
    }

    const schemaHint = `Expected schema for ${serverName}.${action.tool}:\n${JSON.stringify(this.toFullMcpToolRecords([targetTool])[0], null, 2)}`;
    const validation = this.validateMcpArguments(action.arguments ?? {}, targetTool.inputSchema);
    if (!validation.ok) {
      throw new Error([
        `MCP tool call was not sent because arguments do not match ${serverName}.${action.tool}.`,
        `Validation errors:\n${validation.errors.map((error) => `- ${error}`).join('\n')}`,
        `Provided arguments:\n${JSON.stringify(action.arguments ?? {}, null, 2)}`,
        schemaHint,
        'Next action: emit list_mcp_tools with this exact server and tool, then retry call_mcp_tool using only schema-valid arguments.',
      ].join('\n\n'));
    }

    return {
      server: serverName,
      tool: action.tool,
      arguments: validation.value,
      schemaHint,
    };
  }

  private async resolveMcpIntent(action: McpResolveActionShape): Promise<string> {
    if (!this.mcp) {
      throw new Error('MCP is not available in this extension build.');
    }
    if (!action.intent) {
      throw new Error('MCP intent resolution is missing required "intent". Describe the high-level MCP operation to resolve.');
    }

    const tools = await this.mcp.listTools();
    if (tools.length === 0) {
      throw new Error('No MCP tools are configured. Add servers to webagentCode.mcp.servers or Codex ~/.codex/config.toml.');
    }

    const filteredTools = action.server ? tools.filter((tool) => tool.server === action.server) : tools;
    if (filteredTools.length === 0) {
      throw new Error(`No tools found for MCP server "${action.server}". Available servers: ${[...new Set(tools.map((tool) => tool.server))].sort().join(', ')}`);
    }

    const candidates = this.rankMcpTools(filteredTools, action.intent, action.knownArguments ?? {});
    const best = candidates[0];
    const responseBase = {
      intent: action.intent,
      requestedServer: action.server,
      knownArguments: action.knownArguments ?? {},
      candidates: candidates.slice(0, 5).map((candidate) => ({
        server: candidate.server,
        tool: candidate.name,
        score: candidate.score,
        args: this.describeMcpSchemaSignature(candidate.inputSchema),
        description: candidate.description,
        reasons: candidate.reasons,
      })),
    };

    if (!best || best.score < 8) {
      return [
        'MCP_INTENT_RESOLUTION:',
        JSON.stringify({
          status: 'low_confidence',
          ...responseBase,
          message: 'No MCP tool matched the intent strongly enough. Refine the intent or specify the server/tool from MCP_TOOL_CATALOG.',
        }, null, 2),
      ].join('\n');
    }

    const second = candidates[1];
    if (second && best.score - second.score < 3 && best.score < 18) {
      return [
        'MCP_INTENT_RESOLUTION:',
        JSON.stringify({
          status: 'low_confidence',
          ...responseBase,
          message: 'Multiple MCP tools are plausible. Choose one candidate explicitly or provide more intent details.',
        }, null, 2),
      ].join('\n');
    }

    const validation = this.validateMcpArguments(action.knownArguments ?? {}, best.inputSchema);
    const schema = this.toFullMcpToolRecords([best])[0];
    if (!validation.ok) {
      return [
        'MCP_INTENT_RESOLUTION:',
        JSON.stringify({
          status: 'needs_more_info',
          ...responseBase,
          selected: {
            server: best.server,
            tool: best.name,
            score: best.score,
            args: this.describeMcpSchemaSignature(best.inputSchema),
            description: best.description,
            schema,
          },
          validationErrors: validation.errors,
          message: 'The tool was resolved, but the known arguments are incomplete or invalid. Provide/fix only the listed fields, then call resolve_mcp_intent again or call_mcp_tool with schema-valid arguments.',
        }, null, 2),
      ].join('\n');
    }

    return [
      'MCP_INTENT_RESOLUTION:',
      JSON.stringify({
        status: 'ready',
        ...responseBase,
        selected: {
          server: best.server,
          tool: best.name,
          score: best.score,
          args: this.describeMcpSchemaSignature(best.inputSchema),
          description: best.description,
          schema,
        },
        nextAction: {
          type: 'call_mcp_tool',
          server: best.server,
          tool: best.name,
          arguments: validation.value,
        },
        message: 'Emit the nextAction exactly to execute this MCP call. It will still pass approval and preflight validation before execution.',
      }, null, 2),
    ].join('\n');
  }

  private rankMcpTools(
    tools: Array<{ server: string; name: string; description?: string; inputSchema?: unknown }>,
    intent: string,
    knownArguments: Record<string, unknown>,
  ): McpToolCandidate[] {
    const intentText = `${intent} ${Object.keys(knownArguments).join(' ')} ${Object.values(knownArguments).map((value) => typeof value === 'string' ? value : '').join(' ')}`;
    const intentTokens = this.tokenize(intentText);
    const intentTokenSet = new Set(intentTokens);
    const normalizedIntent = this.normalizeSearchText(intent);

    return tools
      .map((tool) => {
        const schemaSignature = this.describeMcpSchemaSignature(tool.inputSchema) ?? '';
        const propertyNames = this.getSchemaPropertyNames(tool.inputSchema);
        const nameTokens = this.tokenize(this.splitIdentifier(tool.name));
        const serverTokens = this.tokenize(this.splitIdentifier(tool.server));
        const descriptionTokens = this.tokenize(tool.description ?? '');
        const schemaTokens = this.tokenize(`${schemaSignature} ${propertyNames.join(' ')}`);
        const reasons: string[] = [];
        let score = 0;

        if (normalizedIntent.includes(this.normalizeSearchText(tool.name))) {
          score += 45;
          reasons.push('intent contains exact tool name');
        }

        for (const token of nameTokens) {
          if (intentTokenSet.has(token)) {
            score += 9;
          }
        }
        for (const token of serverTokens) {
          if (intentTokenSet.has(token)) {
            score += 4;
          }
        }
        for (const token of descriptionTokens) {
          if (intentTokenSet.has(token)) {
            score += 3;
          }
        }
        for (const token of schemaTokens) {
          if (intentTokenSet.has(token)) {
            score += 2;
          }
        }

        const matchedNameTokens = nameTokens.filter((token) => intentTokenSet.has(token));
        const matchedSchemaKeys = Object.keys(knownArguments).filter((key) => propertyNames.includes(key));
        const unknownSchemaKeys = Object.keys(knownArguments).filter((key) => !propertyNames.includes(key));

        if (matchedNameTokens.length > 0) {
          reasons.push(`matched tool-name tokens: ${matchedNameTokens.join(', ')}`);
        }
        if (matchedSchemaKeys.length > 0) {
          score += matchedSchemaKeys.length * 7;
          reasons.push(`known argument keys match schema: ${matchedSchemaKeys.join(', ')}`);
        }
        if (unknownSchemaKeys.length > 0 && propertyNames.length > 0) {
          score -= Math.min(unknownSchemaKeys.length * 3, 12);
          reasons.push(`known argument keys not in schema: ${unknownSchemaKeys.join(', ')}`);
        }

        return {
          server: tool.server,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          score,
          reasons,
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || `${left.server}.${left.name}`.localeCompare(`${right.server}.${right.name}`));
  }

  private formatMcpToolCatalog(tools: Array<{ server: string; name: string; description?: string; inputSchema?: unknown }>): string {
    const summaryByServer: Record<string, { tool: string; args?: string; description?: string }[]> = {};
    for (const tool of [...tools].sort((left, right) => `${left.server}.${left.name}`.localeCompare(`${right.server}.${right.name}`))) {
      if (!summaryByServer[tool.server]) {
        summaryByServer[tool.server] = [];
      }
      summaryByServer[tool.server].push({
        tool: tool.name,
        args: this.describeMcpSchemaSignature(tool.inputSchema),
        description: tool.description ? truncate(tool.description.replace(/\s+/g, ' ').trim(), 140) : undefined,
      });
    }

    return [
      'Complete MCP tool catalog. This is a directory of every callable MCP tool, not the full schemas.',
      'Before calling a tool, request its exact schema with {"type":"list_mcp_tools","server":"serverName","tool":"toolName"}.',
      JSON.stringify(summaryByServer, null, 2),
    ].join('\n');
  }

  private formatMcpToolList(tools: Array<{ server: string; name: string; description?: string; inputSchema?: unknown }>, server?: string, toolName?: string): string {
    if (server) {
      const serverTools = tools.filter(t => t.server === server);
      if (serverTools.length === 0) {
        return `No tools found for MCP server "${server}". Available servers: ${[...new Set(tools.map(t => t.server))].join(', ')}`;
      }

      if (toolName) {
        const tool = serverTools.find((entry) => entry.name === toolName);
        if (!tool) {
          return `No MCP tool "${toolName}" found on server "${server}". Available tools: ${serverTools.map((entry) => entry.name).sort().join(', ')}`;
        }

        return [
          `Exact schema for ${server}.${toolName}:`,
          JSON.stringify(this.toFullMcpToolRecords([tool])[0], null, 2),
        ].join('\n');
      }

      return [
        `Complete MCP tool catalog for ${server}. This is a directory, not full schemas.`,
        'Before calling a tool, request its exact schema with {"type":"list_mcp_tools","server":"serverName","tool":"toolName"}.',
        JSON.stringify(this.toCatalogRecords(serverTools), null, 2),
      ].join('\n');
    }

    return this.formatMcpToolCatalog(tools);
  }

  private toFullMcpToolRecords(tools: Array<{ server: string; name: string; description?: string; inputSchema?: unknown }>): Array<{ server: string; tool: string; description?: string; inputSchema?: unknown }> {
    return tools.map((tool) => ({
      server: tool.server,
      tool: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  private toCatalogRecords(tools: Array<{ server: string; name: string; description?: string; inputSchema?: unknown }>): Array<{ server: string; tool: string; args?: string; description?: string }> {
    return [...tools]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((tool) => ({
        server: tool.server,
        tool: tool.name,
        args: this.describeMcpSchemaSignature(tool.inputSchema),
        description: tool.description ? truncate(tool.description.replace(/\s+/g, ' ').trim(), 180) : undefined,
      }));
  }

  private buildUnknownMcpToolMessage(tools: Array<{ server: string; name: string }>, server: string, toolName: string): string {
    const serverTools = tools.filter((tool) => tool.server === server).map((tool) => tool.name).sort();
    const suggestions = this.findClosestNames(toolName, serverTools);
    return [
      `MCP tool "${toolName}" was not found on server "${server}".`,
      serverTools.length ? `Available tools on ${server}: ${serverTools.join(', ')}` : `Available servers: ${[...new Set(tools.map((tool) => tool.server))].sort().join(', ') || 'none'}`,
      suggestions.length ? `Closest tool names: ${suggestions.join(', ')}` : undefined,
      'Next action: choose an exact tool name from MCP_TOOL_CATALOG or call list_mcp_tools for the server.',
    ].filter(Boolean).join('\n\n');
  }

  private describeMcpSchemaSignature(schema: unknown): string | undefined {
    const objectSchema = this.asRecord(schema);
    if (!objectSchema) {
      return undefined;
    }

    const properties = this.asRecord(objectSchema.properties);
    if (!properties) {
      return this.schemaTypeName(objectSchema) ?? undefined;
    }

    const required = Array.isArray(objectSchema.required) ? objectSchema.required.map(String) : [];
    const entries = Object.entries(properties).map(([name, value]) => {
      const marker = required.includes(name) ? 'required' : 'optional';
      return `${name}:${this.schemaTypeName(value) ?? 'any'} ${marker}`;
    });

    return entries.length ? entries.join(', ') : 'no arguments';
  }

  private getSchemaPropertyNames(schema: unknown): string[] {
    const objectSchema = this.asRecord(schema);
    const properties = this.asRecord(objectSchema?.properties);
    return properties ? Object.keys(properties) : [];
  }

  private validateMcpArguments(args: Record<string, unknown>, schema: unknown): McpSchemaValidationResult {
    const normalized = this.unwrapMcpArguments(args, schema);
    const errors = this.validateJsonSchemaValue(normalized, schema, 'arguments');
    return { ok: errors.length === 0, value: normalized, errors };
  }

  private unwrapMcpArguments(args: Record<string, unknown>, schema: unknown): Record<string, unknown> {
    const objectSchema = this.asRecord(schema);
    const properties = this.asRecord(objectSchema?.properties);
    if (!properties) {
      return args;
    }

    for (const wrapper of ['arguments', 'args', 'input', 'parameters']) {
      const wrapped = args[wrapper];
      if (this.asRecord(wrapped) && !Object.prototype.hasOwnProperty.call(properties, wrapper)) {
        return wrapped as Record<string, unknown>;
      }
    }

    return args;
  }

  private validateJsonSchemaValue(value: unknown, schema: unknown, path: string): string[] {
    const record = this.asRecord(schema);
    if (!record) {
      return [];
    }

    const errors: string[] = [];
    const enumValues = Array.isArray(record.enum) ? record.enum : undefined;
    if (enumValues && !enumValues.some((entry) => Object.is(entry, value))) {
      errors.push(`${path} must be one of ${enumValues.map((entry) => JSON.stringify(entry)).join(', ')}`);
    }

    const expectedTypes = this.schemaTypes(record);
    if (expectedTypes.length > 0 && !expectedTypes.some((type) => this.valueMatchesJsonType(value, type))) {
      errors.push(`${path} must be ${expectedTypes.join(' or ')}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`);
      return errors;
    }

    const expectsObject = expectedTypes.includes('object') || Boolean(record.properties);
    if (expectsObject && !this.asRecord(value)) {
      errors.push(`${path} must be object, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`);
      return errors;
    }

    if ((expectedTypes.length === 0 || expectedTypes.includes('object') || Boolean(record.properties)) && this.asRecord(value)) {
      const objectValue = value as Record<string, unknown>;
      const properties = this.asRecord(record.properties) ?? {};
      const required = Array.isArray(record.required) ? record.required.map(String) : [];
      for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(objectValue, key)) {
          errors.push(`${path}.${key} is required`);
        }
      }

      for (const [key, nestedSchema] of Object.entries(properties)) {
        if (Object.prototype.hasOwnProperty.call(objectValue, key)) {
          errors.push(...this.validateJsonSchemaValue(objectValue[key], nestedSchema, `${path}.${key}`));
        }
      }

      if (record.additionalProperties === false) {
        for (const key of Object.keys(objectValue)) {
          if (!Object.prototype.hasOwnProperty.call(properties, key)) {
            errors.push(`${path}.${key} is not allowed by the schema`);
          }
        }
      }
    }

    if ((expectedTypes.length === 0 || expectedTypes.includes('array')) && Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        errors.push(...this.validateJsonSchemaValue(value[index], record.items, `${path}[${index}]`));
      }
    }

    return errors;
  }

  private schemaTypes(schema: Record<string, unknown>): string[] {
    if (Array.isArray(schema.type)) {
      return schema.type.map(String);
    }
    return typeof schema.type === 'string' ? [schema.type] : [];
  }

  private schemaTypeName(schema: unknown): string | undefined {
    const record = this.asRecord(schema);
    if (!record) {
      return undefined;
    }
    const types = this.schemaTypes(record);
    if (types.length > 0) {
      return types.join('|');
    }
    if (Array.isArray(record.enum)) {
      return `enum(${record.enum.map((entry) => JSON.stringify(entry)).join('|')})`;
    }
    if (record.properties) {
      return 'object';
    }
    if (record.items) {
      return 'array';
    }
    return undefined;
  }

  private valueMatchesJsonType(value: unknown, type: string): boolean {
    switch (type) {
      case 'array':
        return Array.isArray(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number';
      case 'object':
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
      case 'string':
        return typeof value === 'string';
      case 'null':
        return value === null;
      default:
        return true;
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private splitIdentifier(value: string): string {
    return value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-./:]+/g, ' ');
  }

  private normalizeSearchText(value: string): string {
    return this.tokenize(this.splitIdentifier(value)).join(' ');
  }

  private tokenize(value: string): string[] {
    const stopWords = new Set([
      'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with',
    ]);
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !stopWords.has(token));
  }

  private findClosestNames(value: string, candidates: string[]): string[] {
    return candidates
      .map((candidate) => ({ candidate, distance: this.levenshtein(value.toLowerCase(), candidate.toLowerCase()) }))
      .filter((entry) => entry.distance <= Math.max(3, Math.floor(value.length / 3)))
      .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
      .slice(0, 5)
      .map((entry) => entry.candidate);
  }

  private levenshtein(left: string, right: string): number {
    const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
      const current = [leftIndex + 1];
      for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
        const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
        current[rightIndex + 1] = Math.min(
          current[rightIndex] + 1,
          previous[rightIndex + 1] + 1,
          previous[rightIndex] + cost,
        );
      }
      previous.splice(0, previous.length, ...current);
    }
    return previous[right.length];
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
      { oldValue: oldString, newValue: this.normalizeProviderEscapedMultiline(newString, oldString) },
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

  private normalizeProviderEscapedMultiline(value: string, comparisonText = ''): string {
    const escapedNewlineCount = (value.match(/\\r\\n|\\n|\\r/g) || []).length;
    if (escapedNewlineCount === 0) {
      return value;
    }

    const realNewlineCount = (value.match(/\r\n|\n|\r/g) || []).length;
    if (realNewlineCount >= escapedNewlineCount) {
      return value;
    }

    const decoded = this.decodeProviderEscapes(value);
    if (!/[\r\n]/.test(decoded)) {
      return value;
    }

    const comparisonHasNewlines = /[\r\n]/.test(comparisonText);
    const likelyWholeFile = realNewlineCount === 0 && (escapedNewlineCount >= 2 || decoded.length > 120);
    const likelyMultilineReplacement = comparisonHasNewlines || escapedNewlineCount >= 2;
    return likelyWholeFile || likelyMultilineReplacement ? decoded : value;
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
