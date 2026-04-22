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
    try {
      return JSON.parse(candidate);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }

      const pathRepaired = this.repairKnownWindowsPathFields(candidate);
      if (pathRepaired !== candidate) {
        return JSON.parse(pathRepaired);
      }
      throw error;
    }
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
}
