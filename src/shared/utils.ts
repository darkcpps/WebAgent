export function createId(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

export function truncate(value: string, max = 500): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n...`;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export interface SanitizeResponseOptions {
  preferJson?: boolean;
}

export function sanitizeResponse(text: string, options: SanitizeResponseOptions = {}): string {
  if (!text) {
    return '';
  }

  const { preferJson = false } = options;
  let cleaned = text.trim();

  // 1. Remove XML-style thinking/thought tags first.
  // Instead of returning "Thinking..." if unclosed, we strip the tag and show what we have.
  cleaned = cleaned.replace(/<(think|thought|reasoning|analysis)>([\s\S]*?)(?:<\/\1>|$)/gi, '');
  
  cleaned = cleaned.replace(/<details[\s\S]*?<\/details>/gi, '');
  cleaned = cleaned.replace(/<summary>[\s\S]*?<\/summary>/gi, '');

  if (preferJson) {
    const jsonCandidate = extractJsonCandidate(cleaned);
    if (jsonCandidate) {
      return jsonCandidate;
    }
  }

  // 2. Define markers for thinking and answers
  const thinkingPatterns = ['Thinking', 'Thought Process', 'Reasoning', 'Analysis', 'Scratchpad', 'Thought'];
  const answerPatterns = ['Answer', 'Final Answer', 'Response', 'Result', '##'];

  // 3. Remove common homepage/header garbage that might be picked up by heuristics
  const garbage = [
    /z\.ai - free ai chatbot/i,
    /agent powered by glm/i,
    /powered by glm-5/i,
    /chat with z\.ai/i,
    /log in to save your/i,
    /select a model/i
  ];
  
  for (const pattern of garbage) {
    if (pattern.test(cleaned) && cleaned.length < 200) {
      return '';
    }
  }

  // Handle Markdown separators like --- or *** often used to wrap thinking
  cleaned = cleaned.replace(/^(?:---|[*]{3,})\s*\n[\s\S]*?\n(?:---|[*]{3,})$/gm, '');
  cleaned = cleaned.replace(/^\s*(?:#{1,3}\s*)?(?:Thought Process|Reasoning|Analysis|Scratchpad)\s*:?\s*$/gim, '');

  const thinkingRegex = new RegExp(
    `(?:^|\\n)(?:#{1,3}\\s+)?(?:${thinkingPatterns.join('|')})\\s*[:\\n][\\s\\S]*?(?=\\n(?:#{1,3}\\s+)?(?:${answerPatterns.join('|')})|$)`,
    'gi'
  );

  const hasAnswerMarker = new RegExp(`(?:${answerPatterns.join('|')})`, 'i').test(cleaned);
  
  // 4. Aggressive block removal ONLY if we have a clear transition to an answer.
  if (hasAnswerMarker) {
    const stripped = cleaned.replace(thinkingRegex, '').trim();
    if (stripped) {
      cleaned = stripped;
    }
  }

  // 4. Remove standalone "Thinking..." lines
  cleaned = cleaned.replace(/^\s*(?:Thinking|Analyzing|Reasoning|Processing)\.\.\.\s*$/gim, '');
  
  // 5. Remove "Answer:" or "Response:" prefixes if they were left at the top
  cleaned = cleaned.replace(/^\s*(?:Answer|Final Answer|Response|Result)\s*[:\n]\s*/i, '');

  if (preferJson) {
    const jsonCandidate = extractJsonCandidate(cleaned);
    if (jsonCandidate) {
      return jsonCandidate;
    }
  }
  
  const final = cleaned.trim();
  if (!final && text.trim().length > 0) {
     if (!hasAnswerMarker) {
       return 'Thinking...';
     }
     return '';
  }

  // If the final text looks like agent-style JSON, extract readable content from it.
  // This handles cases where Z.ai wraps its response in {"summary":"...","actions":[...]}
  if (!preferJson) {
    const readable = tryExtractReadableFromAgentJson(final);
    if (readable) {
      return readable;
    }
  }

  return final;
}

/**
 * Attempts to parse agent-style JSON and extract a human-readable string from it.
 * Returns undefined if the input is not agent JSON.
 */
function tryExtractReadableFromAgentJson(text: string): string | undefined {
  // Quick heuristic: only try if it looks like it contains "summary" and "actions"
  if (!/"summary"\s*:/.test(text) || !/"actions"\s*:/.test(text)) {
    return undefined;
  }

  // Try to extract the JSON (could be wrapped in ```json ... ```)
  let jsonStr = text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    jsonStr = fenced[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed !== 'object' || !parsed) {
      return undefined;
    }

    const parts: string[] = [];

    // Extract summary
    if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
      parts.push(parsed.summary.trim());
    }

    // Extract readable content from actions
    if (Array.isArray(parsed.actions)) {
      for (const action of parsed.actions) {
        if (!action || typeof action !== 'object') {
          continue;
        }
        if (action.type === 'ask_user' && typeof action.question === 'string') {
          parts.push(action.question);
        } else if (action.type === 'finish' && typeof action.result === 'string') {
          parts.push(action.result);
        }
      }
    }

    if (parts.length > 0) {
      return parts.join('\n\n');
    }
  } catch {
    // Not valid JSON, ignore
  }

  return undefined;
}

function extractJsonCandidate(input: string): string | undefined {
  const fencedMatches = [...input.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim() || '')
    .filter(Boolean);

  for (const candidate of fencedMatches) {
    if (/"actions"\s*:/.test(candidate) || /"summary"\s*:/.test(candidate)) {
      return candidate;
    }
  }

  const balanced = extractBalancedJsonSegments(input);
  if (balanced.length === 0) {
    return undefined;
  }

  const ranked = balanced.sort((left, right) => scoreJsonCandidate(right) - scoreJsonCandidate(left));
  const best = ranked[0];
  if (!best || scoreJsonCandidate(best) <= 0) {
    return undefined;
  }
  return best.trim();
}

function extractBalancedJsonSegments(input: string): string[] {
  const results: string[] = [];
  const openings = new Set(['{', '[']);
  const closings = new Map<string, string>([
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
      if (char !== expected) {
        continue;
      }

      stack.pop();
      if (stack.length === 0) {
        results.push(input.slice(start, index + 1));
        break;
      }
    }
  }

  return results;
}

function scoreJsonCandidate(candidate: string): number {
  let score = 0;
  if (/"actions"\s*:/.test(candidate)) {
    score += 6;
  }
  if (/"summary"\s*:/.test(candidate)) {
    score += 4;
  }
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    score += 2;
  }
  return score;
}
