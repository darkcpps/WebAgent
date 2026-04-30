import type { ProviderId } from '../shared/types';
import { buildProviderPrompt, buildCompactAgentPrompt } from './planner';
import { AgentResponseParser } from './parser';
import { ActionExecutor } from './executor';
import { AgentLedger } from './ledger';
import type { ProviderRegistry } from '../providers/registry';
import type { SessionStore } from '../storage/sessionStore';
import { WorkspaceContextService } from '../workspace/context';
import { CodebaseTierDetector, type CodebaseProfile } from '../workspace/codebaseTier';

export class AgentOrchestrator {
  private readonly parser = new AgentResponseParser();
  private readonly stops = new Set<string>();
  private readonly tierDetector = new CodebaseTierDetector();

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly contextService: WorkspaceContextService,
    private readonly executor: ActionExecutor,
    private readonly sessions: SessionStore,
  ) { }

  async start(sessionId: string, providerId: ProviderId, task: string): Promise<void> {
    this.stops.delete(sessionId);
    this.sessions.setStatus(sessionId, 'running');
    this.sessions.appendLog(sessionId, { level: 'info', source: 'agent', message: `Starting task with ${providerId}.` });

    try {
      const provider = this.providers.get(providerId, { sessionId });
      const ready = await provider.isReady();
      if (!ready) {
        throw new Error(`${providerId} is not ready. Run provider login first.`);
      }

      // Detect codebase tier
      const profile = await this.tierDetector.detect();
      this.sessions.appendLog(sessionId, {
        level: 'info',
        source: 'system',
        message: `Codebase detected: ${profile.tier} (${profile.fileCount} files${profile.isGitRepo ? ', git' : ''})`,
      });

      // Build initial context with tier awareness
      let context = await this.contextService.build(task, {}, profile);
      const toolResults: string[] = [];
      const ledger = new AgentLedger(task, profile);
      const initialMcpContext = await this.executor.getMcpToolPromptContext();
      if (initialMcpContext) {
        toolResults.push(initialMcpContext);
        ledger.recordInitialContext(initialMcpContext);
      }

      const maxRounds = 25;

      for (let round = 0; round < maxRounds; round += 1) {
        if (this.stops.has(sessionId)) {
          this.sessions.setStatus(sessionId, 'stopped');
          this.sessions.appendLog(sessionId, { level: 'warning', source: 'agent', message: 'Task stopped.' });
          return;
        }

        // Context refresh for large repos
        if (this.shouldRefreshContext(round, profile)) {
          context = await this.contextService.build(task, {}, profile);
          this.sessions.appendLog(sessionId, {
            level: 'info',
            source: 'system',
            message: `Context refreshed at round ${round + 1}.`,
          });
        }

        // Use compact prompts for large repos after round 0
        const prompt = this.shouldUseCompactPrompt(round, profile)
          ? buildCompactAgentPrompt(task, context, ledger, profile)
          : buildProviderPrompt(task, context, toolResults, profile);

        await provider.sendPrompt(prompt);
        const responseText = await this.collectProviderText(sessionId, providerId);
        this.sessions.appendRawResponse(sessionId, responseText);
        const parsed = this.parser.parse(responseText);

        this.sessions.appendLog(sessionId, { level: 'info', source: 'provider', message: parsed.summary || `Round ${round + 1} response received.` });

        for (const action of parsed.actions) {
          const result = await this.executor.execute(sessionId, action);
          toolResults.push(`${action.type}: ${result.message}`);
          ledger.recordAction(action, result.message);

          this.sessions.appendLog(sessionId, {
            level: result.message.toLowerCase().includes('failed') || result.message.toLowerCase().includes('blocked') ? 'warning' : 'info',
            source: action.type === 'run_command' ? 'terminal' : 'workspace',
            message: `${action.type}: ${result.message}`,
          });

          if (action.type === 'ask_user') {
            this.sessions.setStatus(sessionId, 'done');
            return;
          }

          if (result.done) {
            this.sessions.setStatus(sessionId, 'done');
            this.sessions.appendLog(sessionId, { level: 'success', source: 'agent', message: result.message });
            return;
          }
        }
      }

      this.sessions.setStatus(sessionId, 'done');
      this.sessions.appendLog(sessionId, { level: 'warning', source: 'agent', message: 'Stopped after reaching max rounds.' });
    } catch (error) {
      this.sessions.setStatus(sessionId, 'error');
      this.sessions.appendLog(sessionId, { level: 'error', source: 'agent', message: (error as Error).message });
    }
  }

  stop(sessionId: string): void {
    this.stops.add(sessionId);
  }

  private shouldRefreshContext(round: number, profile: CodebaseProfile): boolean {
    if (round === 0) return false;
    const interval = profile.contextRefreshInterval;
    if (interval <= 0) return false;
    return round % interval === 0;
  }

  private shouldUseCompactPrompt(round: number, profile: CodebaseProfile): boolean {
    if (round === 0) return false;
    return profile.useCompactPrompts;
  }

  private async collectProviderText(sessionId: string, providerId: ProviderId): Promise<string> {
    const provider = this.providers.get(providerId, { sessionId });
    return new Promise<string>((resolve, reject) => {
      let buffer = '';
      void provider.streamEvents((event) => {
        if (event.type === 'status') {
          this.sessions.appendLog(sessionId, { level: 'info', source: 'provider', message: event.message });
          return;
        }
        if (event.type === 'delta') {
          buffer += event.text;
          return;
        }
        if (event.type === 'done') {
          resolve(event.fullText || buffer);
          return;
        }
        if (event.type === 'error') {
          reject(new Error(event.message));
        }
      });
    });
  }
}
