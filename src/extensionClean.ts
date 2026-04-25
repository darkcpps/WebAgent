import * as vscode from 'vscode';
import { AgentOrchestrator } from './agent/orchestrator';
import { ActionExecutor } from './agent/executor';
import { AgentResponseParser } from './agent/parser';
import { buildPlanningPrompt, buildProviderPrompt } from './agent/planner';
import { ProviderRegistry } from './providers/registry';
import { ApprovalManager } from './safety/approvalManager';
import { SafetyPolicy } from './safety/policy';
import { DiffPreviewService } from './services/diffPreviewService';
import { WebAgentPanel } from './services/webviewPanel';
import { sanitizeResponse } from './shared/utils';
import type { ApprovalMode, ChatMessage, ProviderId, SessionState } from './shared/types';
import type { ProviderAdapter, ProviderPrompt } from './providers/base';
import { SessionStore } from './storage/sessionStore';
import { TerminalRunner } from './terminal/runner';
import { ActivityTreeProvider } from './ui/tree/activityTreeProvider';
import { SessionTreeProvider } from './ui/tree/sessionTreeProvider';
import { WorkspaceContextService } from './workspace/context';
import { WorkspaceFilesService } from './workspace/files';
import { GitService } from './workspace/git';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const AUTO_FOLLOW_UP_DELAY_MS = 1750;
  const configuration = vscode.workspace.getConfiguration('webagentCode');
  const sessions = new SessionStore(context);
  const approvals = new ApprovalManager();
  const providers = new ProviderRegistry(context);
  const files = new WorkspaceFilesService(configuration);
  const git = new GitService();
  const safety = new SafetyPolicy(configuration);
  const diffPreview = new DiffPreviewService();
  const terminal = new TerminalRunner();
  const workspaceContext = new WorkspaceContextService(files);
  const executor = new ActionExecutor(files, git, safety, approvals, sessions, diffPreview, terminal);
  const orchestrator = new AgentOrchestrator(providers, workspaceContext, executor, sessions);
  const parser = new AgentResponseParser();
  const providerReady: Record<ProviderId, boolean> = { chatgpt: false, gemini: false, perplexity: false };

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
          const repoContext = await workspaceContext.build(chatPrompt);
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

        const repoContext = await workspaceContext.build(contextTask);
        const toolResults: string[] = [];
        const compact = (value: string, limit = 180): string => {
          const normalized = value.replace(/\s+/g, ' ').trim();
          return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}...`;
        };
        const describeAction = (action: { type: string; path?: string; query?: string; command?: string; fromPath?: string; toPath?: string }): string => {
          switch (action.type) {
            case 'read_file':
              return `Reading ${action.path ?? 'file'}`;
            case 'edit_file':
              return `Editing ${action.path ?? 'file'}`;
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
        for (let round = 0; round < 25; round += 1) {
          const prompt = buildProviderPrompt(chatPrompt, repoContext, toolResults);
          appendPromptPreviewLog(session.id, 'agent', prompt, round + 1);
          await provider.sendPrompt({ ...prompt, enableThinking: requestThinking });
          const responseText = await collectProviderText(session.id, providerId);
          sessions.appendRawResponse(session.id, responseText);
          let parsed;
          try {
            parsed = parser.parse(responseText);
          } catch {
            const cleaned = cleanFinalResponse(responseText);
            if (assistantMessage) sessions.updateChatMessage(session.id, assistantMessage.id, { content: cleaned, rawContent: responseText });
            sessions.setStatus(session.id, 'done');
            return;
          }
          sessions.appendLog(session.id, { level: 'info', source: 'provider', message: parsed.summary || `Round ${round + 1} response received.` });
          if (parsed.summary) pushActionUpdate(compact(parsed.summary, 220));
          for (const action of parsed.actions) {
            const actionLabel = describeAction(action);
            pushActionUpdate(`${actionLabel}...`);
            const result = await executor.execute(session.id, action);
            toolResults.push(`${action.type}: ${result.message}`);
            pushActionUpdate(`${actionLabel} done.`);
            if (action.type === 'ask_user' || result.done) {
              if (implementationTask && result.done) sessions.update(session.id, { pendingPlan: undefined });
              sessions.setStatus(session.id, 'done');
              if (assistantMessage) sessions.updateChatMessage(session.id, assistantMessage.id, { content: result.message, rawContent: result.message });
              return;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, AUTO_FOLLOW_UP_DELAY_MS));
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
    approve: async (_sessionId: string, actionId: string) => approvals.approve(actionId),
    reject: async (_sessionId: string, actionId: string) => approvals.reject(actionId),
    setActiveSession: (sessionId: string) => sessions.setActive(sessionId),
    getProviderReadyState: () => providerReady,
    setApprovalMode: async (mode: ApprovalMode) => configuration.update('approvalMode', mode, vscode.ConfigurationTarget.Workspace),
    previewSessionChanges: async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      const summaries = session.actionHistory.filter((action) => ['edit_file', 'create_file', 'delete_file', 'rename_file'].includes(action.type) && action.status === 'done').map((action) => action.summary);
      await diffPreview.showSessionChangePreview(session.task, summaries, await git.getDiff().catch(() => 'No diff'));
    },
  };

  const sessionTree = new SessionTreeProvider(sessions);
  const activityTree = new ActivityTreeProvider(sessions);
  const panel = new WebAgentPanel(context.extensionUri, sessions, providers, () => configuration.get<ApprovalMode>('approvalMode', 'ask-before-action'), panelCallbacks);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('webagentCode.sessions', sessionTree),
    vscode.window.registerTreeDataProvider('webagentCode.activity', activityTree),
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
