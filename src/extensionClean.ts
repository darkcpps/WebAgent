import * as vscode from 'vscode';
import { AgentOrchestrator } from './agent/orchestrator';
import { ActionExecutor } from './agent/executor';
import { AgentResponseParser } from './agent/parser';
import { AgentLedger } from './agent/ledger';
import { buildCompactAgentPrompt, buildPlanningPrompt } from './agent/planner';
import type { AgentAction } from './agent/protocol';
import { ProviderRegistry } from './providers/registry';
import { ApprovalManager } from './safety/approvalManager';
import { SafetyPolicy } from './safety/policy';
import { DiffPreviewService } from './services/diffPreviewService';
import { McpManager } from './services/mcpManager';
import { WebAgentPanel } from './services/webviewPanel';
import { sanitizeResponse } from './shared/utils';
import type { ApprovalMode, ChatMessage, ProviderId, SessionState } from './shared/types';
import type { ProviderAdapter, ProviderPrompt } from './providers/base';
import { SessionStore } from './storage/sessionStore';
import { TerminalRunner } from './terminal/runner';
import { ActivityTreeProvider } from './ui/tree/activityTreeProvider';
import { McpTreeProvider } from './ui/tree/mcpTreeProvider';
import { SessionTreeProvider } from './ui/tree/sessionTreeProvider';
import { WorkspaceContextService } from './workspace/context';
import { WorkspaceFilesService } from './workspace/files';
import { GitService } from './workspace/git';
import { SymbolService } from './workspace/symbols';
import { CodebaseTierDetector, type CodebaseProfile } from './workspace/codebaseTier';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const AUTO_FOLLOW_UP_DELAY_MS = 1750;
  const AGENT_PROVIDER_CHAT_ROTATION_ROUNDS = 6;
  const configuration = vscode.workspace.getConfiguration('webagentCode');
  const sessions = new SessionStore(context);
  const approvals = new ApprovalManager();
  const providers = new ProviderRegistry(context);
  const files = new WorkspaceFilesService(configuration);
  const git = new GitService();
  const safety = new SafetyPolicy(configuration);
  const diffPreview = new DiffPreviewService();
  const terminal = new TerminalRunner();
  const mcp = new McpManager(context);
  const mcpOutput = vscode.window.createOutputChannel('WebAgent MCP');
  const symbols = new SymbolService();
  const tierDetector = new CodebaseTierDetector();
  let currentCodebaseProfile: CodebaseProfile | undefined;
  const workspaceContext = new WorkspaceContextService(files, symbols);
  const executor = new ActionExecutor(files, git, safety, approvals, sessions, diffPreview, terminal, mcp, symbols, () => currentCodebaseProfile);
  const orchestrator = new AgentOrchestrator(providers, workspaceContext, executor, sessions);
  const parser = new AgentResponseParser();
  const providerReady: Record<ProviderId, boolean> = { chatgpt: false, kimi: false, perplexity: false, deepseek: false };

  context.subscriptions.push(mcp, mcpOutput);

  const collectProviderText = async (sessionId: string, providerId: ProviderId, onDelta?: (text: string) => void): Promise<string> => {
    const provider = providers.get(providerId, { sessionId });
    return new Promise<string>((resolve, reject) => {
      let buffer = '';
      void provider.streamEvents((event) => {
        if (event.type === 'status') {
          sessions.appendLog(sessionId, { level: 'info', source: 'provider', message: event.message });
          return;
        }
        if (event.type === 'metadata') {
          if (event.conversationId) sessions.setProviderSessionId(sessionId, event.conversationId);
          return;
        }
        if (event.type === 'delta') {
          buffer += event.text;
          onDelta?.(buffer);
          return;
        }
        if (event.type === 'done') {
          resolve(event.fullText || buffer);
          return;
        }
        if (event.type === 'error') reject(new Error(event.message));
      });
    });
  };

  const cleanFinalResponse = (text: string, options?: { preferJson?: boolean }): string => sanitizeResponse(text, options) || 'No response text was parsed from provider.';
  const truncatePromptPreview = (value: string, limit = 2200): string => value.length <= limit ? value : `${value.slice(0, limit)}\n\n...[truncated ${value.length - limit} chars]`;
  const compactText = (value: string, limit: number): string => {
    const normalized = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n').trim();
    return normalized.length <= limit ? normalized : `${normalized.slice(0, limit).trim()}\n...[truncated ${normalized.length - limit} chars]`;
  };

  const buildRegenerationHandoffPrompt = (sourceSession: SessionState, retryMessage: string): string => {
    const targetUserIndex = (() => {
      for (let index = sourceSession.chatHistory.length - 1; index >= 0; index -= 1) {
        const entry = sourceSession.chatHistory[index];
        if (entry?.role === 'user' && entry.content.trim() === retryMessage.trim()) return index;
      }
      for (let index = sourceSession.chatHistory.length - 1; index >= 0; index -= 1) {
        if (sourceSession.chatHistory[index]?.role === 'user') return index;
      }
      return -1;
    })();

    const priorMessages = targetUserIndex >= 0 ? sourceSession.chatHistory.slice(Math.max(0, targetUserIndex - 12), targetUserIndex) : [];
    const summarizedTurns = priorMessages.map((entry: ChatMessage) => {
      const role = entry.role === 'assistant' ? 'Assistant' : entry.role === 'user' ? 'User' : 'System';
      const content = sanitizeResponse(entry.rawContent || entry.content);
      if (!content || /^thinking\.\.\.$/i.test(content.trim())) return undefined;
      return `- ${role}: ${compactText(content, role === 'Assistant' ? 900 : 700)}`;
    }).filter((entry): entry is string => Boolean(entry));

    const recentActions = sourceSession.actionHistory.filter((action) => action.status === 'done' || action.status === 'error').slice(-8).map((action) => {
      const result = action.result ? ` Result: ${compactText(action.result, 240)}` : '';
      return `- ${action.type}: ${compactText(action.summary || action.type, 180)} (${action.status}).${result}`;
    });

    const contextBlocks: string[] = [];
    if (sourceSession.pendingPlan?.plan) contextBlocks.push(['Pending plan from previous chat:', compactText(`Original request: ${sourceSession.pendingPlan.originalRequest}\n\nPlan:\n${sourceSession.pendingPlan.plan}`, 2200)].join('\n'));
    if (summarizedTurns.length > 0) contextBlocks.push(['Recent conversation summary:', ...summarizedTurns].join('\n'));
    if (recentActions.length > 0) contextBlocks.push(['Recent IDE action summary:', ...recentActions].join('\n'));
    if (contextBlocks.length === 0) return retryMessage;
    return ['The previous chat response took longer than 5 minutes, so this is a retry in a new chat.', 'Use the compact context below only as background. The user prompt after the separator is the task to answer now.', '', compactText(contextBlocks.join('\n\n'), 8500), '', '---', 'User prompt to retry:', retryMessage].join('\n');
  };

  const buildChatAskPrompt = (userPrompt: string, options: { wasPreviouslyAgentMode: boolean }): ProviderPrompt => ({
    systemPrompt: [
      'You are in Chat/Ask mode inside an IDE conversation.',
      'Respond conversationally and helpfully to the user question.',
      'Do not proactively debug, diagnose, trace root causes, or suggest step-by-step troubleshooting unless the user explicitly asks to debug, fix, troubleshoot, investigate, diagnose, or shares an error/broken behavior.',
      'For ordinary questions, answer directly and keep any code reasoning high-level unless deeper analysis is requested.',
      'Do not output tool-action JSON and do not behave as an autonomous agent in this mode.',
      'Explain code changes clearly when asked, and ask clarifying questions if context is missing.',
      options.wasPreviouslyAgentMode ? 'Important: Previous agent-mode instructions in this thread are inactive. Ignore them unless the user explicitly asks to enable Agent Mode again.' : 'Stay in Chat/Ask mode unless the user explicitly asks to switch to Agent Mode.',
    ].join('\n'),
    userPrompt,
  });

  const compactPlanForImplementation = (plan: string, limit = 7000): { text: string; truncated: boolean } => {
    const normalized = plan.split(/\r?\n/).map((line) => line.trimEnd()).join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
    if (normalized.length <= limit) return { text: normalized, truncated: false };
    return { text: `${normalized.slice(0, limit).trim()}\n\n[Plan compacted for provider prompt budget. Continue by inspecting files and following the stored plan intent.]`, truncated: true };
  };

  const buildAgentTaskFromPlan = (originalRequest: string, plan: string): { task: string; planWasCompacted: boolean } => {
    const compactPlan = compactPlanForImplementation(plan);
    return { task: ['Implement the approved Planning Mode plan below.', '', `Original request:\n${originalRequest}`, '', `Approved plan excerpt:\n${compactPlan.text}`, '', 'Follow the plan, adapt if the codebase requires it, and verify the result before finishing.'].join('\n'), planWasCompacted: compactPlan.truncated };
  };

  const appendPromptPreviewLog = (sessionId: string, mode: 'chat' | 'agent' | 'plan', prompt: ProviderPrompt, round?: number): void => {
    const label = mode === 'chat' ? 'Chat/Ask' : mode === 'plan' ? 'Planning' : round ? `Agent (round ${round})` : 'Agent';
    sessions.appendLog(sessionId, { level: 'info', source: 'agent', message: `${label} prompt preview\nSystem:\n${truncatePromptPreview(prompt.systemPrompt)}\n\nUser:\n${truncatePromptPreview(prompt.userPrompt)}` });
  };

  const getConversationIdSafely = async (provider: ProviderAdapter, timeoutMs = 7000): Promise<string | undefined> => await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    void provider.getCurrentConversationId().then((conversationId) => { clearTimeout(timer); resolve(conversationId); }).catch(() => { clearTimeout(timer); resolve(undefined); });
  });

  const normalizeProviderError = (error: unknown): { displayMessage: string; rawMessage: string; transient: boolean } => {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const transient = /no response,\s*please try again later|unexpected token '<'|<!doctype|not valid json/i.test(rawMessage);
    return { displayMessage: transient ? 'Provider returned a temporary error page (likely rate-limited). Wait a bit before sending the next prompt, then try again.' : rawMessage, rawMessage, transient };
  };

  const withTimeoutFallback = async <T>(operation: () => Promise<T>, timeoutMs: number, fallbackValue: T): Promise<T> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<T>((resolve) => { timeoutHandle = setTimeout(() => resolve(fallbackValue), timeoutMs); });
    try { return await Promise.race([operation(), timeoutPromise]); } finally { if (timeoutHandle) clearTimeout(timeoutHandle); }
  };

  const panelCallbacks = {
    newChat: async (providerId: ProviderId) => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const session = sessions.create(providerId, 'Chat session', workspaceRoot);
      sessions.setActive(session.id);
      const conversationId = await providers.get(providerId, { sessionId: session.id }).startNewConversation();
      if (conversationId) sessions.setProviderSessionId(session.id, conversationId);
      sessions.setStatus(session.id, 'idle');
    },
    deleteChat: async (sessionId: string) => sessions.delete(sessionId),
    startTask: async (providerId: ProviderId, task: string) => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const session = sessions.create(providerId, task, workspaceRoot);
      void orchestrator.start(session.id, providerId, task);
    },
    sendChat: async (providerId: ProviderId, message: string, modelId?: string, sessionId?: string, agentMode?: boolean, planningMode?: boolean, enableThinking?: boolean) => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      const wasEmptySession = (existing?.chatHistory.length ?? 0) === 0;
      const session = existing && existing.providerId === providerId ? existing : sessions.create(providerId, 'Chat session', workspaceRoot);
      sessions.setActive(session.id);
      sessions.appendChatMessage(session.id, { role: 'user', content: message, modelId });
      const assistantMessage = sessions.appendChatMessage(session.id, { role: 'assistant', content: 'Working...', modelId: modelId && modelId !== 'auto' ? modelId : undefined, rawContent: '' });
      sessions.setStatus(session.id, 'running');

      try {
        currentCodebaseProfile = await tierDetector.detect();
        const provider = providers.get(providerId, { sessionId: session.id });
        if (!providerReady[providerId] || !existing) {
          const readiness = await provider.checkReady();
          providerReady[providerId] = readiness.ready;
          if (!readiness.ready) throw new Error(readiness.loginRequired ? `${providerId} is not signed in. Click Login first.` : `${providerId} is not ready yet.`);
        }

        const browserConversationId = await provider.getCurrentConversationId().catch(() => undefined);
        const sessionConversationId = sessions.get(session.id)?.providerSessionId;
        if (sessionConversationId && browserConversationId !== sessionConversationId) await provider.openConversation(sessionConversationId).catch(() => false);
        if (!sessionConversationId && wasEmptySession && browserConversationId) await provider.startNewConversation().catch(() => undefined);
        if (!sessionConversationId && !wasEmptySession && browserConversationId) sessions.setProviderSessionId(session.id, browserConversationId);

        let requestedModelId = providerId === 'perplexity' ? undefined : modelId;
        if (providerId === 'perplexity' && modelId && modelId !== 'auto') {
          sessions.appendLog(session.id, { level: 'info', source: 'provider', message: 'Perplexity model selection is controlled in the browser. To select a model, choose it in the Perplexity browser window opened by the IDE.' });
        }

        if (requestedModelId && requestedModelId !== 'auto') {
          const selected = await withTimeoutFallback(() => provider.selectModel(requestedModelId!), providerId === 'perplexity' ? 20000 : 12000, false).catch(() => false);
          if (!selected) sessions.appendLog(session.id, { level: 'warning', source: 'provider', message: `Could not select model ${requestedModelId} quickly. Proceeding with current/default model.` });
        }

        const trimmedMessage = message.trim();
        const explicitAgent = /^\/agent\s+/i.test(trimmedMessage);
        const explicitPlan = /^\/plan\s+/i.test(trimmedMessage);
        const activePendingPlan = sessions.get(session.id)?.pendingPlan;
        const promptWithoutCommand = explicitAgent ? trimmedMessage.replace(/^\/agent\s+/i, '').trim() : explicitPlan ? trimmedMessage.replace(/^\/plan\s+/i, '').trim() : trimmedMessage;
        const isImplementPlanRequest = /^implement\s+(this\s+|the\s+)?plan$/i.test(promptWithoutCommand);
        const implementationTask = isImplementPlanRequest && activePendingPlan ? buildAgentTaskFromPlan(activePendingPlan.originalRequest, activePendingPlan.plan) : undefined;
        const usePlanningMode = (Boolean(planningMode) || explicitPlan) && !(isImplementPlanRequest && activePendingPlan);
        const useAgentTools = !usePlanningMode && (Boolean(agentMode) || explicitAgent);
        const chatPrompt = implementationTask ? implementationTask.task : promptWithoutCommand;
        const contextTask = implementationTask && activePendingPlan ? activePendingPlan.originalRequest : chatPrompt;
        const requestThinking = providerId === 'perplexity' ? enableThinking : undefined;
        const promptBudgetProfile = providerId === 'perplexity' ? 'compact' : 'default';
        const wasPreviouslyAgentMode = sessions.get(session.id)?.lastPromptMode === 'agent';
        const resolvedAgentTools = useAgentTools || (isImplementPlanRequest && Boolean(activePendingPlan));
        sessions.update(session.id, { lastPromptMode: usePlanningMode ? 'plan' : resolvedAgentTools ? 'agent' : 'chat', pendingPlan: implementationTask ? undefined : activePendingPlan });
        if (!chatPrompt) throw new Error('Empty message.');
        if (implementationTask?.planWasCompacted) sessions.appendLog(session.id, { level: 'info', source: 'agent', message: 'Approved plan was compacted before implementation to stay within provider prompt limits.' });

        if (usePlanningMode) {
          const repoContext = await workspaceContext.build(chatPrompt, {}, currentCodebaseProfile);
          const existingPlan = activePendingPlan ? { originalRequest: activePendingPlan.originalRequest, plan: activePendingPlan.plan } : undefined;
          const prompt = buildPlanningPrompt(chatPrompt, repoContext, existingPlan);
          appendPromptPreviewLog(session.id, 'plan', prompt);
          await provider.sendPrompt({ ...prompt, enableThinking: requestThinking });
          const responseText = await collectProviderText(session.id, providerId);
          const cleaned = cleanFinalResponse(responseText);
          sessions.appendRawResponse(session.id, cleaned);
          sessions.update(session.id, { pendingPlan: { originalRequest: activePendingPlan?.originalRequest ?? chatPrompt, plan: cleaned, createdAt: Date.now() } });
          if (assistantMessage) sessions.updateChatMessage(session.id, assistantMessage.id, { content: cleaned, rawContent: responseText });
          sessions.setStatus(session.id, 'done');
          const conversationId = await getConversationIdSafely(provider).catch(() => undefined);
          if (conversationId) sessions.setProviderSessionId(session.id, conversationId);
          return;
        }

        if (!resolvedAgentTools) {
          const prompt = buildChatAskPrompt(chatPrompt, { wasPreviouslyAgentMode });
          appendPromptPreviewLog(session.id, 'chat', prompt);
          await provider.sendPrompt({ ...prompt, enableThinking: requestThinking });
          const responseText = await collectProviderText(session.id, providerId);
          const cleaned = cleanFinalResponse(responseText);
          sessions.appendRawResponse(session.id, cleaned);
          if (assistantMessage) sessions.updateChatMessage(session.id, assistantMessage.id, { content: cleaned, rawContent: responseText });
          sessions.setStatus(session.id, 'done');
          const conversationId = await getConversationIdSafely(provider).catch(() => undefined);
          if (conversationId) sessions.setProviderSessionId(session.id, conversationId);
          return;
        }

        const repoContext = await workspaceContext.build(contextTask, { includeFileContents: false, includeWorkspaceRoot: false }, currentCodebaseProfile);
        const toolResults: string[] = [];
        const ledger = new AgentLedger(chatPrompt, currentCodebaseProfile);
        const initialMcpContext = await executor.getMcpToolPromptContext();
        if (initialMcpContext) {
          ledger.recordInitialContext(initialMcpContext);
          toolResults.push(initialMcpContext);
        }
        sessions.appendLog(session.id, {
          level: 'info',
          source: 'agent',
          message: `Compact agent context enabled. Agent mode keeps the current provider chat for the first round, then starts a fresh provider chat every ${AGENT_PROVIDER_CHAT_ROTATION_ROUNDS} rounds within the same run and uses the local task ledger as memory.`,
        });
        const compact = (value: string, limit = 180): string => {
          const normalized = value.replace(/\s+/g, ' ').trim();
          return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}...`;
        };
        const describeAction = (action: { type?: string; path?: string; query?: string; command?: string; fromPath?: string; toPath?: string; server?: string; tool?: string }): string => {
          switch (action.type) {
            case 'inspect_repo':
              return 'Inspecting repo';
            case 'read_file':
              return `Reading ${action.path ?? 'file'}`;
            case 'read_many_files':
              return 'Reading files';
            case 'search_code':
              return `Searching code "${compact(action.query ?? '', 80)}"`;
            case 'edit_file':
              return `Editing ${action.path ?? 'file'}`;
            case 'apply_patch':
              return 'Applying patch';
            case 'replace_range':
              return `Replacing ${action.path ?? 'file'} range`;
            case 'create_file':
              return `Creating ${action.path ?? 'file'}`;
            case 'delete_file':
              return `Deleting ${action.path ?? 'file'}`;
            case 'rename_file':
              return `Renaming ${action.fromPath ?? 'source'} -> ${action.toPath ?? 'target'}`;
            case 'search_files':
              return `Searching "${compact(action.query ?? '', 80)}"`;
            case 'list_files':
              return 'Listing files';
            case 'run_command':
              return `Running ${compact(action.command ?? '', 80)}`;
            case 'get_git_diff':
              return 'Reading git diff';
            case 'list_mcp_tools':
              return 'Listing MCP tools';
            case 'resolve_mcp_intent':
              return `Resolving MCP intent${action.server ? ` on ${action.server}` : ''}`;
            case 'call_mcp_tool':
              return `Calling MCP ${action.server ?? 'server'}.${action.tool ?? 'tool'}`;
            case 'ask_user':
              return 'Asking for input';
            case 'finish':
              return 'Finalizing';
            default:
              return action.type;
          }
        };
        const actionUpdates: string[] = [];
        const pushActionUpdate = (line: string): void => {
          actionUpdates.push(line);
          if (actionUpdates.length > 8) actionUpdates.shift();
          if (assistantMessage) {
            const content = ['Working...', '', ...actionUpdates.map((entry, index) => `${index + 1}. ${entry}`)].join('\n');
            sessions.updateChatMessage(session.id, assistantMessage.id, { content, rawContent: content });
          }
        };
        const pushToolResult = (entry: string): void => {
          toolResults.push(entry);
          if (toolResults.length > 10) toolResults.shift();
        };
        const pushActionResult = (action: AgentAction, resultMessage: string): void => {
          ledger.recordAction(action, resultMessage);
          pushToolResult(`${action.type}: ${resultMessage}`);
        };
        const isFailedActionMessage = (message: string): boolean =>
          /^(Action failed:|Blocked action |User rejected action )/i.test(message.trim());
        const mutationPaths = (action: AgentAction): string[] => {
          switch (action.type) {
            case 'edit_file':
            case 'replace_range':
            case 'create_file':
            case 'delete_file':
              return [action.path];
            case 'rename_file':
              return [action.fromPath, action.toPath];
            case 'apply_patch':
              return [...new Set((action.patches ?? []).map((patch) => patch.path))];
            default:
              return [];
          }
        };
        const isBrittleMutationRetry = (action: AgentAction): boolean =>
          action.type === 'apply_patch' || (action.type === 'edit_file' && typeof action.content !== 'string');
        const isMutationAction = (action: AgentAction): boolean =>
          ['edit_file', 'create_file', 'delete_file', 'rename_file', 'apply_patch', 'replace_range'].includes(action.type);
        const taskRequiresMutation = (): boolean =>
          /\b(create|add|write|implement|modify|edit|update|fix|repair|change|delete|remove|rename|move|patch|refactor|build)\b/i.test(chatPrompt);
        const looksLikeIncompleteToolJson = (value: string): boolean => {
          const text = cleanFinalResponse(value, { preferJson: true }).trim();
          if (!/(?:"actions"|"type"|create_file|edit_file|apply_patch|replace_range|write_file)/i.test(text)) return false;
          if (!/^[\s`]*(?:```json\s*)?[{[]/i.test(text)) return false;

          const stack: string[] = [];
          let inString = false;
          let escaped = false;
          for (const char of text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '')) {
            if (inString) {
              if (escaped) escaped = false;
              else if (char === '\\') escaped = true;
              else if (char === '"') inString = false;
              continue;
            }
            if (char === '"') inString = true;
            else if (char === '{' || char === '[') stack.push(char);
            else if (char === '}' || char === ']') stack.pop();
          }
          return inString || stack.length > 0 || !/[}\]]\s*(?:```)?\s*$/.test(text);
        };
        let verificationPrompted = false;
        let codeChangesApplied = false;
        let invalidToolResponseCount = 0;
        const filesNeedingFullRewrite = new Set<string>();
        const maxRounds = Math.max(1, configuration.get<number>('agent.maxRounds', 25));
        for (let round = 0; round < maxRounds; round += 1) {
          if (round > 0 && round % AGENT_PROVIDER_CHAT_ROTATION_ROUNDS === 0) {
            const conversationId = await provider.startNewConversation().catch((error) => {
              sessions.appendLog(session.id, {
                level: 'warning',
                source: 'provider',
                message: `Could not start a fresh provider chat for agent round ${round + 1}: ${(error as Error).message}`,
              });
              return undefined;
            });
            if (conversationId) sessions.setProviderSessionId(session.id, conversationId);
          }
          const prompt = buildCompactAgentPrompt(chatPrompt, repoContext, ledger, currentCodebaseProfile);
          appendPromptPreviewLog(session.id, 'agent', prompt, round + 1);
          await provider.sendPrompt({ ...prompt, enableThinking: requestThinking });
          let responseText = await collectProviderText(session.id, providerId);
          sessions.appendRawResponse(session.id, responseText);
          let parsed;
          for (let parseAttempt = 0; parseAttempt < (providerId === 'deepseek' ? 8 : 1); parseAttempt += 1) {
            try {
              parsed = parser.parse(responseText);
              break;
            } catch (error) {
              if ((providerId === 'deepseek' || providerId === 'kimi') && looksLikeIncompleteToolJson(responseText) && parseAttempt < 7) {
                const waitMs = 5000;
                sessions.appendLog(session.id, {
                  level: 'info',
                  source: 'agent',
                  message: `DeepSeek response looks like partial tool JSON; waiting ${waitMs / 1000}s before parsing again.`,
                });
                pushActionUpdate('Waiting for DeepSeek to finish the current tool JSON response.');
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                responseText = await collectProviderText(session.id, providerId);
                sessions.appendRawResponse(session.id, responseText);
                continue;
              }

            invalidToolResponseCount += 1;
            const message = [
              'SYSTEM_FEEDBACK: Your previous response did not use valid executable tool JSON.',
              `Parse error: ${error instanceof Error ? error.message : String(error)}`,
              'Your next response must be raw JSON only, with actions containing executable IDE tools.',
              'If the user asked for file changes, do not answer conversationally; emit create_file/edit_file/replace_range/apply_patch instead.',
            ].join('\n');
            ledger.recordSystemFeedback(message);
            pushToolResult(message);
            pushActionUpdate('Auto-recovery: requested valid tool JSON after invalid response.');
            if (invalidToolResponseCount <= 4) {
              continue;
            }
            if (assistantMessage) sessions.updateChatMessage(session.id, assistantMessage.id, { content: 'Need your input to continue. The provider repeatedly returned invalid tool JSON.', rawContent: responseText });
            sessions.setStatus(session.id, 'done');
            return;
            }
          }
          if (!parsed) return;
          invalidToolResponseCount = 0;
          sessions.appendLog(session.id, { level: 'info', source: 'provider', message: parsed.summary || `Round ${round + 1} response received.` });
          if (parsed.summary) pushActionUpdate(compact(parsed.summary, 220));
          const actionsToExecute: AgentAction[] = parsed.actions.length > 1 ? [parsed.actions[0]] : parsed.actions;
          if (parsed.actions.length > 1) {
            sessions.appendLog(session.id, {
              level: 'info',
              source: 'agent',
              message: `Provider returned ${parsed.actions.length} actions; executing only the first so Agent Mode advances one step at a time.`,
            });
            pushActionUpdate(`Step mode: executing first of ${parsed.actions.length} proposed actions.`);
          }

          for (const action of actionsToExecute) {
            const autoVerify = configuration.get<'off' | 'after-edits' | 'before-finish'>('agent.autoVerify', 'after-edits');
            if (action.type === 'finish' && taskRequiresMutation() && !codeChangesApplied) {
              const message = [
                'SYSTEM_FEEDBACK: Do not finish yet. The user requested a code/file change, but no IDE mutation action has succeeded.',
                'Your next response must be raw JSON only.',
                'Emit create_file, edit_file, replace_range, apply_patch, delete_file, or rename_file before finish.',
              ].join('\n');
              ledger.recordSystemFeedback(message);
              pushToolResult(message);
              pushActionUpdate('Auto-recovery: rejected premature finish and requested a real file-change action.');
              continue;
            }
            if (action.type === 'finish' && !verificationPrompted && autoVerify !== 'off' && ledger.hasUnverifiedChanges()) {
              verificationPrompted = true;
              const message = 'Verification is still pending after file changes. Run an appropriate existing check/build/test command, inspect the diff, or finish only if you explicitly state verification was skipped and why.';
              ledger.recordSystemFeedback(message);
              pushToolResult(`verification_required: ${message}`);
              pushActionUpdate('Verification needed before final response.');
              continue;
            }
            const retryPaths = mutationPaths(action).filter((path) => filesNeedingFullRewrite.has(path));
            if (retryPaths.length > 0 && isBrittleMutationRetry(action)) {
              const message = [
                'SYSTEM_FEEDBACK: Do not retry another oldString/apply_patch edit for this file.',
                `Files that need a full-content rewrite after a failed exact-match edit: ${retryPaths.join(', ')}`,
                'Read the current file if needed, then emit edit_file with the content field containing the entire updated file.',
                'Do not use oldString/newString or apply_patch for these files again in this task.',
              ].join('\n');
              ledger.recordSystemFeedback(message);
              pushToolResult(`full_rewrite_required: ${message}`);
              pushActionUpdate(`Recovery: requested full-file edit for ${retryPaths.join(', ')}.`);
              continue;
            }
            const actionLabel = describeAction(action);
            pushActionUpdate(`${actionLabel}...`);
            const result = await executor.execute(session.id, action);
            pushActionResult(action, result.message);
            const failed = isFailedActionMessage(result.message);
            pushActionUpdate(failed ? `${actionLabel} failed.` : `${actionLabel} done.`);
            if (failed && ['edit_file', 'apply_patch', 'replace_range'].includes(action.type)) {
              for (const path of mutationPaths(action)) {
                filesNeedingFullRewrite.add(path);
              }
              const message = [
                'SYSTEM_FEEDBACK: The previous file edit failed in IDE execution.',
                `Failure detail: ${compact(result.message, 700)}`,
                `Affected files: ${mutationPaths(action).join(', ')}`,
                'Recover by reading the current target file, then emit edit_file with the content field containing the entire updated file.',
                'Do not retry oldString/newString or apply_patch for those files.',
              ].join('\n');
              ledger.recordSystemFeedback(message);
              pushToolResult(`edit_recovery_hint: ${message}`);
            } else if (!failed && isMutationAction(action)) {
              codeChangesApplied = true;
              for (const path of mutationPaths(action)) {
                filesNeedingFullRewrite.delete(path);
              }
            }
            if (action.type === 'ask_user' || result.done) {
              if (implementationTask && result.done) sessions.update(session.id, { pendingPlan: undefined });
              sessions.setStatus(session.id, 'done');
              if (assistantMessage) sessions.updateChatMessage(session.id, assistantMessage.id, { content: result.message, rawContent: result.message });
              return;
            }
          }
          const followUpDelay = AUTO_FOLLOW_UP_DELAY_MS;
          if (followUpDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, followUpDelay));
          }
        }
        if (implementationTask) sessions.update(session.id, { pendingPlan: undefined });
        if (assistantMessage) {
          const content = ['Task complete.', ...(actionUpdates.length ? ['', 'Recent actions:', ...actionUpdates.map((entry, index) => `${index + 1}. ${entry}`)] : [])].join('\n');
          sessions.updateChatMessage(session.id, assistantMessage.id, { content, rawContent: content });
        }
        sessions.setStatus(session.id, 'done');
      } catch (error) {
        const normalized = normalizeProviderError(error);
        sessions.appendLog(session.id, { level: normalized.transient ? 'warning' : 'error', source: 'provider', message: normalized.displayMessage });
        if (assistantMessage) sessions.updateChatMessage(session.id, assistantMessage.id, { content: normalized.displayMessage, rawContent: normalized.rawMessage });
        sessions.setStatus(session.id, 'error');
      }
    },
    regenerateChatInNewSession: async (providerId: ProviderId, sourceSessionId: string, message: string, modelId?: string, agentMode?: boolean, planningMode?: boolean, enableThinking?: boolean) => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const sourceSession = sessions.get(sourceSessionId);
      const retryMessage = sourceSession ? buildRegenerationHandoffPrompt(sourceSession, message) : message;
      const session = sessions.create(providerId, 'Regenerated chat', workspaceRoot);
      sessions.setActive(session.id);
      await panelCallbacks.sendChat(providerId, retryMessage, modelId, session.id, agentMode, planningMode, enableThinking);
    },
    stopTask: async (sessionId: string) => {
      orchestrator.stop(sessionId);
      await providers.get(sessions.get(sessionId)?.providerId ?? 'chatgpt', { sessionId }).stop().catch(() => undefined);
      sessions.setStatus(sessionId, 'stopped');
    },
    loginProvider: async (providerId: ProviderId) => {
      await providers.get(providerId, { sessionId: sessions.getActive()?.id }).login();
      providerReady[providerId] = false;
    },
    logoutProvider: async (providerId: ProviderId) => providers.get(providerId, { sessionId: sessions.getActive()?.id }).logout(),
    checkProviderReady: async (providerId: ProviderId) => {
      const readiness = await providers.get(providerId, { sessionId: sessions.getActive()?.id }).checkReady();
      providerReady[providerId] = readiness.ready;
      return readiness;
    },
    refreshProviderModels: async (providerId: ProviderId) => (await providers.get(providerId, { sessionId: sessions.getActive()?.id }).refreshModels()).length,
    resetConversation: async (providerId: ProviderId) => {
      const provider = providers.get(providerId, { sessionId: sessions.getActive()?.id });
      const conversationId = await provider.startNewConversation();
      const active = sessions.getActive();
      if (active) sessions.setProviderSessionId(active.id, conversationId);
    },
    openMcpServersView: async () => {
      mcpTree.refresh();
      await vscode.commands.executeCommand('workbench.view.extension.webagentCode');
      await vscode.commands.executeCommand('webagentCode.mcp.focus');
    },
    approve: async (_sessionId: string, actionId: string) => approvals.approve(actionId),
    reject: async (_sessionId: string, actionId: string) => approvals.reject(actionId),
    setActiveSession: (sessionId: string) => sessions.setActive(sessionId),
    getProviderReadyState: () => providerReady,
    setApprovalMode: async (mode: ApprovalMode) => configuration.update('approvalMode', mode, vscode.ConfigurationTarget.Workspace),
    previewSessionChanges: async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      const summaries = session.actionHistory.filter((action) => ['edit_file', 'create_file', 'delete_file', 'rename_file', 'apply_patch', 'replace_range'].includes(action.type) && action.status === 'done').map((action) => action.summary);
      await diffPreview.showSessionChangePreview(session.task, summaries, await git.getDiff().catch(() => 'No diff'));
    },
  };

  const sessionTree = new SessionTreeProvider(sessions);
  const activityTree = new ActivityTreeProvider(sessions);
  const mcpTree = new McpTreeProvider(mcp);
  const panel = new WebAgentPanel(context.extensionUri, sessions, providers, () => configuration.get<ApprovalMode>('approvalMode', 'ask-before-action'), panelCallbacks);
  const getMcpServerNameFromCommand = async (node: unknown): Promise<string | undefined> => {
    const name = typeof (node as { status?: { name?: unknown } } | undefined)?.status?.name === 'string'
      ? (node as { status: { name: string } }).status.name
      : undefined;
    if (name) {
      return name;
    }

    const configs = await mcp.getAllServerConfigs();
    return await vscode.window.showQuickPick(Object.keys(configs).sort(), { title: 'Choose MCP server' });
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('webagentCode.sessions', sessionTree),
    vscode.window.registerTreeDataProvider('webagentCode.activity', activityTree),
    vscode.window.registerTreeDataProvider('webagentCode.mcp', mcpTree),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('webagentCode.mcp')) {
        mcpTree.refresh();
      }
    }),
    vscode.commands.registerCommand('webagentCode.open', () => panel.show()),
    vscode.commands.registerCommand('webagentCode.startTask', async () => {
      const providerId = await vscode.window.showQuickPick(providers.list(), { title: 'Choose provider' }) as ProviderId | undefined;
      if (!providerId) return;
      const task = await vscode.window.showInputBox({ prompt: 'Describe the task for WebAgent Code' });
      if (task) await panelCallbacks.startTask(providerId, task);
    }),
    vscode.commands.registerCommand('webagentCode.stopTask', async () => {
      const active = sessions.getActive();
      if (active) await panelCallbacks.stopTask(active.id);
    }),
    vscode.commands.registerCommand('webagentCode.loginProvider', async () => {
      const providerId = await vscode.window.showQuickPick(providers.list(), { title: 'Choose provider to login' }) as ProviderId | undefined;
      if (providerId) await panelCallbacks.loginProvider(providerId);
    }),
    vscode.commands.registerCommand('webagentCode.resetConversation', async () => {
      const active = sessions.getActive();
      if (active) await panelCallbacks.resetConversation(active.providerId);
    }),
    vscode.commands.registerCommand('webagentCode.listMcpTools', async () => {
      try {
        const tools = await mcp.listTools();
        mcpOutput.clear();
        mcpOutput.appendLine(`Discovered ${tools.length} MCP tool${tools.length === 1 ? '' : 's'}.`);
        for (const tool of tools) {
          mcpOutput.appendLine('');
          mcpOutput.appendLine(`${tool.server}.${tool.name}`);
          if (tool.description) {
            mcpOutput.appendLine(tool.description);
          }
          if (tool.inputSchema) {
            mcpOutput.appendLine(JSON.stringify(tool.inputSchema, null, 2));
          }
        }
        mcpOutput.show(true);
        await vscode.window.showInformationMessage(`WebAgent Code discovered ${tools.length} MCP tool${tools.length === 1 ? '' : 's'}.`);
      } catch (error) {
        const message = (error as Error).message;
        mcpOutput.clear();
        mcpOutput.appendLine(message);
        mcpOutput.show(true);
        await vscode.window.showErrorMessage(`WebAgent Code MCP discovery failed: ${message}`);
      }
    }),
    vscode.commands.registerCommand('webagentCode.refreshMcpServers', async () => {
      mcpTree.refresh();
      await vscode.window.showInformationMessage('WebAgent Code MCP status refreshed.');
    }),
    vscode.commands.registerCommand('webagentCode.disableMcpServer', async (node?: unknown) => {
      const server = await getMcpServerNameFromCommand(node);
      if (!server) {
        return;
      }

      await mcp.setServerDisabled(server, true);
      mcpTree.refresh();
      await vscode.window.showInformationMessage(`Disabled MCP server "${server}". It will be hidden from Agent Mode prompts.`);
    }),
    vscode.commands.registerCommand('webagentCode.enableMcpServer', async (node?: unknown) => {
      const server = await getMcpServerNameFromCommand(node);
      if (!server) {
        return;
      }

      await mcp.setServerDisabled(server, false);
      mcpTree.refresh();
      await vscode.window.showInformationMessage(`Enabled MCP server "${server}".`);
    }),
    vscode.commands.registerCommand('webagentCode.approvePendingAction', async () => {
      const active = sessions.getActive();
      if (active?.approvalRequest) approvals.approve(active.approvalRequest.actionId);
    }),
    vscode.commands.registerCommand('webagentCode.rejectPendingAction', async () => {
      const active = sessions.getActive();
      if (active?.approvalRequest) approvals.reject(active.approvalRequest.actionId);
    }),
  );

  panel.show();
}

export function deactivate(): void {}
