import type { AgentAction } from './protocol';

interface FileReadState {
  ranges: string[];
  facts: string[];
}

export class AgentLedger {
  private readonly filesRead = new Map<string, FileReadState>();
  private readonly filesChanged = new Set<string>();
  private readonly errors: string[] = [];
  private readonly verification: string[] = [];
  private readonly facts: string[] = [];
  private latestObservation = '';

  constructor(private readonly userGoal: string) {}

  recordInitialContext(context: string | undefined): void {
    if (!context?.trim()) {
      return;
    }
    this.latestObservation = this.compact(context, 5000);
  }

  recordSystemFeedback(message: string): void {
    this.latestObservation = this.compact(message, 1800);
    if (/failed|blocked|invalid|error/i.test(message)) {
      this.pushLimited(this.errors, this.compact(message, 320), 6);
    }
  }

  recordAction(action: AgentAction, result: string): void {
    const compactResult = this.compact(result, this.limitForAction(action.type));
    this.latestObservation = `${action.type}: ${compactResult}`;

    if (/^(Action failed:|Blocked action |User rejected action )/i.test(result.trim())) {
      this.pushLimited(this.errors, `${action.type}: ${this.compact(result, 360)}`, 6);
      return;
    }

    switch (action.type) {
      case 'read_file':
        this.recordRead(action.path, result);
        break;
      case 'read_many_files':
        for (const file of action.files) {
          this.recordRead(file.path, result);
        }
        break;
      case 'inspect_repo':
        this.pushLimited(this.facts, `Inspected repo: ${this.compact(result, 420)}`, 8);
        break;
      case 'search_code':
        this.pushLimited(this.facts, `Searched code "${action.query}" and got ${this.compact(result, 280)}`, 8);
        break;
      case 'search_files':
        this.pushLimited(this.facts, `Searched "${action.query}" and got ${this.compact(result, 280)}`, 8);
        break;
      case 'list_files':
        this.pushLimited(this.facts, `Listed workspace files. ${this.compact(result, 240)}`, 8);
        break;
      case 'edit_file':
      case 'create_file':
      case 'delete_file':
        this.filesChanged.add(action.path);
        this.pushLimited(this.facts, `${action.type} succeeded for ${action.path}.`, 8);
        break;
      case 'apply_patch':
        for (const patch of action.patches) {
          this.filesChanged.add(patch.path);
        }
        this.pushLimited(this.facts, `apply_patch succeeded for ${[...new Set(action.patches.map((patch) => patch.path))].join(', ')}.`, 8);
        break;
      case 'rename_file':
        this.filesChanged.add(action.fromPath);
        this.filesChanged.add(action.toPath);
        this.pushLimited(this.facts, `Renamed ${action.fromPath} -> ${action.toPath}.`, 8);
        break;
      case 'run_command':
        this.pushLimited(this.verification, `${action.command}: ${this.compact(result, 420)}`, 6);
        break;
      case 'get_git_diff':
        this.pushLimited(this.facts, `Inspected git diff: ${this.compact(result, 420)}`, 8);
        break;
      case 'resolve_mcp_intent':
      case 'list_mcp_tools':
      case 'call_mcp_tool':
        this.pushLimited(this.facts, `${action.type}: ${this.compact(result, 520)}`, 8);
        break;
      case 'ask_user':
      case 'finish':
        break;
    }
  }

  toPromptSummary(): string {
    const readFiles = [...this.filesRead.entries()].map(([path, state]) => {
      const ranges = state.ranges.join(', ') || 'read';
      const facts = state.facts.length ? `; facts: ${state.facts.join(' | ')}` : '';
      return `- ${path}: ${ranges}${facts}`;
    });

    const sections = [
      `User goal: ${this.compact(this.userGoal, 900)}`,
      this.facts.length ? `Known facts:\n${this.facts.map((fact) => `- ${fact}`).join('\n')}` : '',
      readFiles.length ? `Files read this run:\n${readFiles.join('\n')}` : '',
      this.filesChanged.size ? `Files changed this run:\n${[...this.filesChanged].map((file) => `- ${file}`).join('\n')}` : '',
      this.errors.length ? `Recent errors/blocks:\n${this.errors.map((error) => `- ${error}`).join('\n')}` : '',
      this.verification.length ? `Verification:\n${this.verification.map((entry) => `- ${entry}`).join('\n')}` : '',
      this.latestObservation ? `Latest observation:\n${this.latestObservation}` : '',
    ].filter(Boolean);

    return this.compact(sections.join('\n\n'), 9000);
  }

  hasUnverifiedChanges(): boolean {
    return this.filesChanged.size > 0 && this.verification.length === 0;
  }

  private recordRead(path: string, result: string): void {
    const state = this.filesRead.get(path) ?? { ranges: [], facts: [] };
    const range = result.match(/Read .+ lines (\d+-\d+) of \d+/i)?.[1];
    if (range && !state.ranges.includes(range)) {
      state.ranges.push(range);
    }

    const codePreview = result
      .split(/\r?\n/)
      .filter((line) => /^\d+:\s/.test(line))
      .slice(0, 12)
      .map((line) => line.replace(/^\d+:\s?/, '').trim())
      .filter(Boolean)
      .join(' ');
    if (codePreview) {
      this.pushLimited(state.facts, this.compact(codePreview, 300), 3);
    }

    this.filesRead.set(path, state);
  }

  private limitForAction(actionType: string): number {
    const limits: Record<string, number> = {
      read_file: 4500,
      read_many_files: 9000,
      inspect_repo: 3000,
      search_files: 1800,
      search_code: 2200,
      list_files: 1600,
      run_command: 2200,
      get_git_diff: 2200,
      list_mcp_tools: 5000,
      resolve_mcp_intent: 5000,
      call_mcp_tool: 5000,
    };
    return limits[actionType] ?? 1400;
  }

  private pushLimited(items: string[], value: string, max: number): void {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    items.push(trimmed);
    while (items.length > max) {
      items.shift();
    }
  }

  private compact(value: string, limit: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= limit) {
      return normalized;
    }
    return `${normalized.slice(0, limit)}...`;
  }
}
