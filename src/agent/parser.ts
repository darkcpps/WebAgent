import { ZodError } from 'zod';
import { agentResponseSchema, type AgentResponse } from './protocol';

export class AgentResponseParser {
  parse(input: string): AgentResponse {
    const candidates = this.extractCandidates(input);

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

    // 1. Try to find fenced code blocks
    const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
    for (const match of fencedMatches) {
      candidates.push(match[1].trim());
    }

    // 2. Try to find balanced JSON objects or arrays anywhere in the text.
    candidates.push(...this.extractBalancedJson(trimmed));

    // 3. Fallback to just the trimmed input
    candidates.push(trimmed);

    const repaired = candidates.map((candidate) => this.repairJson(candidate));
    const uniqueCandidates = [...new Set(repaired)].filter(Boolean);
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
        return this.normalizeResponseShape(JSON.parse(variant));
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
    const variants = [
      candidate.trim(),
      this.repairKnownWindowsPathFields(candidate.trim()),
      this.repairCommonJsonIssues(candidate.trim()),
      this.repairKnownWindowsPathFields(this.repairCommonJsonIssues(candidate.trim())),
    ];

    return [...new Set(variants)].filter(Boolean);
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

    return repaired.trim();
  }

  private normalizeResponseShape(value: unknown): unknown {
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
      edit: 'edit_file',
      editfile: 'edit_file',
      edit_file: 'edit_file',
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
