import { ZodError } from 'zod';
import { agentResponseSchema, type AgentResponse } from './protocol';

export class AgentResponseParser {
  parse(input: string): AgentResponse {
    // Strip XML thinking tags so the parser doesn't get confused by reasoning blocks.
    const strippedInput = input.replace(/<(think|thought|reasoning|analysis)>([\s\S]*?)(?:<\/\1>|$)/gi, '');
    const candidates = this.extractCandidates(strippedInput);

    for (const candidate of candidates) {
      try {
        return agentResponseSchema.parse(this.parseCandidate(candidate));
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof ZodError) {
          continue;
        }
        throw error;
      }
    }

    throw new Error('Provider did not return valid action JSON.');
  }

  private extractCandidates(input: string): string[] {
    const candidates: string[] = [];
    const trimmed = input.trim();
    const normalizedInputs = this.buildCandidateTextVariants(trimmed);

    // 1. Try to find fenced code blocks
    const fencedMatches = normalizedInputs.flatMap((candidate) => [...candidate.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]);
    for (const match of fencedMatches) {
      candidates.push(match[1].trim());
    }

    // 2. Try to find balanced JSON objects or arrays anywhere in the text.
    for (const candidate of normalizedInputs) {
      candidates.push(...this.extractBalancedJson(candidate));
    }

    // 3. Fallback to just the trimmed input
    candidates.push(...normalizedInputs);

    const repaired = candidates.map((candidate) => this.repairJson(candidate));
    const uniqueCandidates = [...new Set(repaired.flatMap((candidate) => this.buildCandidateTextVariants(candidate)))].filter(Boolean);
    return uniqueCandidates.sort((left, right) => this.rankCandidate(right) - this.rankCandidate(left));
  }

  private repairJson(candidate: string): string {
    const repaired = candidate
      .replace(/^[^{\[]+/, '')
      .replace(/,\s*([}\]])/g, '$1')
      .trim();

    return this.repairKnownWindowsPathFields(repaired);
  }

  private extractBalancedJson(input: string): string[] {
    const results: string[] = [];
    const openings = new Set(['{', '[']);
    const closings = new Map([
      ['{', '}'],
      ['[', ']'],
    ]);

    for (let start = 0; start < input.length; start += 1) {
      const first = input[start];
      if (!openings.has(first)) {
        continue;
      }

      const stack: string[] = [first];
      let inString = false;
      let escaped = false;

      for (let index = start + 1; index < input.length; index += 1) {
        const char = input[index];

        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (char === '\\') {
            escaped = true;
            continue;
          }
          if (char === '"') {
            inString = false;
          }
          continue;
        }

        if (char === '"') {
          inString = true;
          continue;
        }

        if (openings.has(char)) {
          stack.push(char);
          continue;
        }

        const expected = closings.get(stack[stack.length - 1]);
        if (char === expected) {
          stack.pop();
          if (stack.length === 0) {
            results.push(input.slice(start, index + 1));
            break;
          }
        }
      }
    }

    return results;
  }

  private rankCandidate(candidate: string): number {
    let score = 0;
    if (/"actions"\s*:/.test(candidate)) {
      score += 5;
    }
    if (/"summary"\s*:/.test(candidate)) {
      score += 3;
    }
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      score += 2;
    }
    return score;
  }

  private parseCandidate(candidate: string): unknown {
    const variants = this.buildParseVariants(candidate);
    let lastSyntaxError: SyntaxError | undefined;

    for (const variant of variants) {
      try {
        const parsed = JSON.parse(variant);
        if (typeof parsed === 'string' && this.looksLikeAgentJson(parsed)) {
          const nested = this.parseCandidate(parsed);
          return this.normalizeResponseShape(nested);
        }
        return this.normalizeResponseShape(parsed);
      } catch (error) {
        if (error instanceof SyntaxError) {
          lastSyntaxError = error;
          continue;
        }
        throw error;
      }
    }

    throw lastSyntaxError ?? new SyntaxError('Unable to parse candidate JSON.');
  }

  private repairKnownWindowsPathFields(candidate: string): string {
    // Some providers emit invalid JSON like "path":"c:\Users\...".
    // Fix only path-like fields to preserve other escaped content (e.g. "\n" in file content).
    return candidate.replace(
      /"((?:path|fromPath|toPath))"\s*:\s*"((?:\\.|[^"\\])*)"/g,
      (_whole, key: string, rawValue: string) => {
        const fixedValue = rawValue.replace(/\\/g, '\\\\');
        return `"${key}":"${fixedValue}"`;
      },
    );
  }

  private buildParseVariants(candidate: string): string[] {
    const variants = this.buildCandidateTextVariants(candidate).flatMap((variant) => [
      variant.trim(),
      this.repairKnownWindowsPathFields(variant.trim()),
      this.repairToolStringFields(variant.trim()),
      this.repairCommonJsonIssues(variant.trim()),
      this.repairCommonJsonIssues(this.repairToolStringFields(variant.trim())),
      this.repairKnownWindowsPathFields(this.repairCommonJsonIssues(variant.trim())),
      this.repairKnownWindowsPathFields(this.repairCommonJsonIssues(this.repairToolStringFields(variant.trim()))),
    ]);

    return [...new Set(variants)].filter(Boolean);
  }

  private buildCandidateTextVariants(candidate: string): string[] {
    const trimmed = candidate.trim();
    const variants = [
      candidate.trim(),
    ];

    const unescaped = this.unescapeLikelyJsonText(trimmed);
    if (unescaped !== trimmed) {
      variants.push(unescaped);
    }

    return [...new Set(variants)].filter(Boolean);
  }

  private unescapeLikelyJsonText(candidate: string): string {
    let value = candidate.trim();
    const unquoted = value.replace(/\\"/g, '"');
    if (!/\\+"/.test(value) || !/(?:"summary"|"actions")\s*:/.test(unquoted)) {
      return value;
    }

    value = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
    value = value.replace(/\\"/g, '"');
    return value.replace(/([}\]])['"]$/, '$1');
  }

  private looksLikeAgentJson(value: string): boolean {
    const trimmed = value.trim();
    return /"?actions"?\s*:/.test(trimmed) || /"?summary"?\s*:/.test(trimmed);
  }

  private repairCommonJsonIssues(candidate: string): string {
    let repaired = candidate.trim();

    repaired = repaired.replace(/^\uFEFF/, '');
    repaired = repaired.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    repaired = repaired.replace(/\/\/[^\n\r]*/g, '');
    repaired = repaired.replace(/\/\*[\s\S]*?\*\//g, '');
    repaired = repaired.replace(/\bTrue\b/g, 'true');
    repaired = repaired.replace(/\bFalse\b/g, 'false');
    repaired = repaired.replace(/\bNone\b/g, 'null');
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');

    // Convert JS-like object keys: {summary: "..."} => {"summary": "..."}
    repaired = repaired.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":');

    // Convert single-quoted keys and values to valid JSON quotes.
    repaired = repaired.replace(/([{,]\s*)'([^'\\]+?)'\s*:/g, '$1"$2":');
    repaired = repaired.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_whole, rawValue: string) => {
      const escaped = rawValue.replace(/"/g, '\\"');
      return `:"${escaped}"`;
    });

    // Fix unescaped newlines in JSON string values
    repaired = repaired.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, inner) => {
      if (inner.includes('\n') || inner.includes('\r')) {
        const escaped = inner.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        return `"${escaped}"`;
      }
      return match;
    });

    return repaired.trim();
  }

  private repairToolStringFields(candidate: string): string {
    let repaired = candidate;

    repaired = this.repairToolStringField(repaired, 'oldString', ['newString']);
    repaired = this.repairToolStringField(repaired, 'newString', ['replaceAll', 'summary', 'type']);
    repaired = this.repairToolStringField(repaired, 'content', ['summary', 'type']);
    repaired = this.repairToolStringField(repaired, 'result', ['summary', 'type']);
    repaired = this.repairToolStringField(repaired, 'command', ['summary', 'type']);

    return repaired;
  }

  private repairToolStringField(candidate: string, field: string, followingKeys: string[]): string {
    const nextKeyPattern = followingKeys.map((key) => this.escapeRegex(key)).join('|');
    const pattern = new RegExp(
      `("${this.escapeRegex(field)}"\\s*:\\s*")([\\s\\S]*?)("\\s*(?:,\\s*"(${nextKeyPattern})"\\s*:|\\}))`,
      'g',
    );

    return candidate.replace(pattern, (_whole, prefix: string, rawValue: string, suffix: string) => {
      return `${prefix}${this.escapeJsonStringContent(rawValue)}${suffix}`;
    });
  }

  private escapeJsonStringContent(value: string): string {
    return JSON.stringify(value).slice(1, -1);
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private normalizeResponseShape(value: unknown): unknown {
    if (Array.isArray(value)) {
      const actions = this.normalizeActionArray(value);
      if (actions.length > 0) {
        return {
          summary: '',
          actions,
        };
      }
    }

    const normalized = this.unwrapContainer(value);
    if (!normalized || typeof normalized !== 'object') {
      return normalized;
    }

    const record = normalized as Record<string, unknown>;
    const summary = typeof record.summary === 'string' ? record.summary : '';
    const rawActions = this.normalizeActionArray(
      record.actions ?? record.action ?? record.tool_calls ?? record.tools ?? record.steps,
    );

    if (rawActions.length > 0 || 'summary' in record) {
      return {
        summary,
        actions: rawActions,
      };
    }

    const singleAction = this.normalizeSingleAction(record);
    if (singleAction) {
      return {
        summary,
        actions: [singleAction],
      };
    }

    return normalized;
  }

  private unwrapContainer(value: unknown): unknown {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && ('actions' in (item as Record<string, unknown>) || 'action' in (item as Record<string, unknown>))) {
          return item;
        }
      }
      return value[0];
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    const record = value as Record<string, unknown>;
    const wrappers = ['response', 'result', 'data', 'payload', 'output'];
    for (const key of wrappers) {
      const wrapped = record[key];
      if (wrapped && typeof wrapped === 'object') {
        const inner = wrapped as Record<string, unknown>;
        if ('actions' in inner || 'action' in inner || 'summary' in inner) {
          return inner;
        }
      }
    }
    return value;
  }

  private normalizeActionArray(value: unknown): unknown[] {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return list
      .map((item) => this.normalizeSingleAction(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }

  private normalizeSingleAction(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const action = value as Record<string, unknown>;
    const typeRaw = action.type ?? action.tool ?? action.name ?? action.action;
    const type = typeof typeRaw === 'string' ? typeRaw.trim() : '';
    if (!type) {
      return undefined;
    }

    const normalizedType = this.normalizeActionType(type);
    const result: Record<string, unknown> = { ...action, type: normalizedType };

    if (normalizedType === 'run_command' && typeof result.command !== 'string') {
      const cmd = action.cmd ?? action.shell;
      if (typeof cmd === 'string') {
        result.command = cmd;
      }
    }

    if (normalizedType === 'rename_file') {
      if (typeof result.fromPath !== 'string' && typeof action.from === 'string') {
        result.fromPath = action.from;
      }
      if (typeof result.toPath !== 'string' && typeof action.to === 'string') {
        result.toPath = action.to;
      }
    }

    if (normalizedType === 'edit_file') {
      if (typeof result.oldString !== 'string' && typeof action.find === 'string') {
        result.oldString = action.find;
      }
      if (typeof result.oldString !== 'string' && typeof action.old === 'string') {
        result.oldString = action.old;
      }
      if (typeof result.newString !== 'string' && typeof action.replacement === 'string') {
        result.newString = action.replacement;
      }
      if (typeof result.newString !== 'string' && typeof action.new === 'string') {
        result.newString = action.new;
      }
    }

    if (normalizedType === 'read_many_files') {
      if (!Array.isArray(result.files)) {
        const paths = action.paths ?? action.path;
        if (Array.isArray(paths)) {
          result.files = paths.map((path) => typeof path === 'string' ? { path } : path);
        } else if (typeof paths === 'string') {
          result.files = [{ path: paths }];
        }
      }
    }

    if (normalizedType === 'search_code' && typeof result.query !== 'string') {
      const query = action.pattern ?? action.text ?? action.term;
      if (typeof query === 'string') {
        result.query = query;
      }
    }

    if (normalizedType === 'inspect_repo' && typeof result.query !== 'string') {
      const query = action.goal ?? action.request ?? action.description;
      if (typeof query === 'string') {
        result.query = query;
      }
    }

    if (normalizedType === 'apply_patch') {
      if (!Array.isArray(result.patches)) {
        const rawPatches = action.replacements ?? action.changes ?? action.edits ?? action.hunks;
        if (Array.isArray(rawPatches)) {
          result.patches = rawPatches;
        } else if (typeof action.path === 'string') {
          const oldString = action.oldString ?? action.find ?? action.old;
          const newString = action.newString ?? action.replacement ?? action.new;
          if (typeof oldString === 'string' && typeof newString === 'string') {
            result.patches = [{ path: action.path, oldString, newString, replaceAll: action.replaceAll }];
          }
        }
      }
    }

    if (normalizedType === 'call_mcp_tool') {
      if (typeof result.server !== 'string' && typeof action.mcpServer === 'string') {
        result.server = action.mcpServer;
      }
      if (typeof result.tool !== 'string') {
        const toolName = action.toolName ?? action.name;
        if (typeof toolName === 'string') {
          result.tool = toolName;
        }
      }
      
      let args = action.arguments ?? action.args ?? action.input ?? action.parameters;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch (e) {
          // Leave it as string, let Zod catch it if it's invalid
        }
      }
      
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        result.arguments = args;
      } else if (!('arguments' in result)) {
        const knownKeys = new Set(['type', 'tool', 'name', 'toolName', 'server', 'mcpServer', 'timeoutMs', 'summary', 'arguments', 'args', 'input', 'parameters']);
        const extras: Record<string, unknown> = {};
        let hasExtras = false;
        for (const [key, value] of Object.entries(action)) {
          if (!knownKeys.has(key)) {
            extras[key] = value;
            hasExtras = true;
          }
        }
        if (hasExtras) {
          result.arguments = extras;
        }
      }
    }

    if (normalizedType === 'list_mcp_tools') {
      if (typeof result.server !== 'string' && typeof action.mcpServer === 'string') {
        result.server = action.mcpServer;
      }
      if (typeof result.tool !== 'string') {
        const toolName = action.toolName ?? action.name;
        if (typeof toolName === 'string') {
          result.tool = toolName;
        }
      }
    }

    if (normalizedType === 'resolve_mcp_intent') {
      if (typeof result.server !== 'string' && typeof action.mcpServer === 'string') {
        result.server = action.mcpServer;
      }
      if (typeof result.intent !== 'string') {
        const intent = action.query ?? action.request ?? action.goal ?? action.description;
        if (typeof intent === 'string') {
          result.intent = intent;
        }
      }

      let knownArguments = action.knownArguments ?? action.arguments ?? action.args ?? action.input ?? action.parameters;
      if (typeof knownArguments === 'string') {
        try {
          knownArguments = JSON.parse(knownArguments);
        } catch {
          // Leave it as string, let Zod catch it if invalid.
        }
      }
      if (knownArguments && typeof knownArguments === 'object' && !Array.isArray(knownArguments)) {
        result.knownArguments = knownArguments;
      }
    }

    return result;
  }

  private normalizeActionType(type: string): string {
    const value = type.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const aliases: Record<string, string> = {
      listfiles: 'list_files',
      list_files: 'list_files',
      read: 'read_file',
      readfile: 'read_file',
      read_file: 'read_file',
      search: 'search_files',
      searchfiles: 'search_files',
      search_files: 'search_files',
      inspect: 'inspect_repo',
      inspectrepo: 'inspect_repo',
      inspect_repo: 'inspect_repo',
      repo_context: 'inspect_repo',
      read_many: 'read_many_files',
      readmany: 'read_many_files',
      readmanyfiles: 'read_many_files',
      read_many_files: 'read_many_files',
      batch_read: 'read_many_files',
      search_code: 'search_code',
      searchcode: 'search_code',
      code_search: 'search_code',
      edit: 'edit_file',
      editfile: 'edit_file',
      edit_file: 'edit_file',
      patch: 'apply_patch',
      apply_patch: 'apply_patch',
      applypatch: 'apply_patch',
      create: 'create_file',
      createfile: 'create_file',
      create_file: 'create_file',
      delete: 'delete_file',
      deletefile: 'delete_file',
      delete_file: 'delete_file',
      rename: 'rename_file',
      renamefile: 'rename_file',
      rename_file: 'rename_file',
      move_file: 'rename_file',
      command: 'run_command',
      run: 'run_command',
      runcommand: 'run_command',
      run_command: 'run_command',
      shell: 'run_command',
      terminal: 'run_command',
      git_diff: 'get_git_diff',
      get_git_diff: 'get_git_diff',
      mcp_tools: 'list_mcp_tools',
      list_mcp_tools: 'list_mcp_tools',
      listmcptools: 'list_mcp_tools',
      call_mcp: 'call_mcp_tool',
      call_mcp_tool: 'call_mcp_tool',
      callmcptool: 'call_mcp_tool',
      mcp_call: 'call_mcp_tool',
      mcp_tool: 'call_mcp_tool',
      resolve_mcp: 'resolve_mcp_intent',
      resolve_mcp_intent: 'resolve_mcp_intent',
      mcp_intent: 'resolve_mcp_intent',
      choose_mcp_tool: 'resolve_mcp_intent',
      route_mcp_tool: 'resolve_mcp_intent',
      ask: 'ask_user',
      ask_user: 'ask_user',
      question: 'ask_user',
      finish: 'finish',
      done: 'finish',
      complete: 'finish',
    };

    return aliases[value] ?? value;
  }
}
