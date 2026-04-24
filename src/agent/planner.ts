import type { RepoContext } from '../workspace/context';

export function buildProviderPrompt(task: string, context: RepoContext, toolResults: string[] = []): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    'You are operating as a coding agent inside an IDE.',
    'You must think like a safe tool-using coding assistant.',
    'Your goal is to complete the user task using the provided tools.',
    '',
    '### TOOL USAGE RULES',
    '1. Return ONLY valid JSON with this exact shape: {"summary":"concise description","actions":[{"type":"tool_name", ...}]}',
    '2. You can perform multiple actions in one turn if they are independent.',
    '3. For sequential actions (e.g., read then edit), wait for the tool result of the first action before emitting the second.',
    '4. Never hallucinate file paths. Use `list_files` or `search_files` if you are unsure.',
    '5. Prefer targeted edits using `oldString` and `newString` for large files to avoid data loss.',
    '6. When the task is complete, use the `finish` action.',
    '7. Do not include your internal reasoning or thought process in the JSON. Put it in the "summary" field if necessary.',
    '8. Use workspace-relative paths only (e.g. "src/app.ts"). Do not use absolute paths like "C:\\\\...".',
    '9. Discovery-first behavior: if the task is not a clearly single-file change, start by exploring with `list_files`/`search_files`, then `read_file` on likely targets.',
    '10. Before any `edit_file`, `delete_file`, or `rename_file`, you must have read that exact target file in this run (except brand new files created with `create_file`).',
    '11. Treat provided context snippets as hints only. For exact code truth, call `read_file` on the target paths before making changes.',
    '12. Never mix `finish` with other actions in the same response. Emit `finish` alone only when no more tool actions are needed.',
    '',
    '### AVAILABLE ACTIONS',
    '- list_files: {"type":"list_files", "limit": 100} - List files in the workspace.',
    '- read_file: {"type":"read_file", "path": "src/app.ts"} - Read file content.',
    '- search_files: {"type":"search_files", "query": "pattern"} - Search for code patterns.',
    '- edit_file: {"type":"edit_file", "path": "file.ts", "oldString": "text to replace", "newString": "new text"} - Replace specific text.',
    '- edit_file (full): {"type":"edit_file", "path": "file.ts", "content": "entire new file content"} - Replace entire file.',
    '- create_file: {"type":"create_file", "path": "new.ts", "content": "initial content"} - Create a new file.',
    '- delete_file: {"type":"delete_file", "path": "obsolete.ts"} - Delete a file.',
    '- rename_file: {"type":"rename_file", "fromPath": "old.ts", "toPath": "new.ts"} - Rename/move a file.',
    '- run_command: {"type":"run_command", "command": "npm test"} - Execute shell commands.',
    '- get_git_diff: {"type":"get_git_diff"} - Get current unstaged changes.',
    '- ask_user: {"type":"ask_user", "question": "..."} - Ask the user for clarification.',
    '- finish: {"type":"finish", "result": "summary of work done"} - Finalize the task.',
    '',
    '### CRITICAL: RESPONSE FORMAT',
    'Your response must be a single JSON object. Do not wrap it in conversational prose. If you must explain, use the "summary" field inside the JSON.',
    'Example:',
    '```json',
    '{"summary":"Searching for the bug","actions":[{"type":"search_files","query":"buggyFunction"}]}',
    '```',
  ].join('\n');

  const relevantFiles = context.relevantFiles
    .map((file) => `### ${file.path}\n${file.content}`)
    .join('\n\n');

  const observations = toolResults.length
    ? `\n\nLatest tool results:\n${toolResults.map((result, index) => `${index + 1}. ${result}`).join('\n\n')}`
    : '';

  const userPrompt = [
    `Task:\n${task}`,
    '',
    'Important operating note:',
    '- The "Relevant files" section may be incomplete or truncated.',
    '- In medium/large repos, narrow scope with `search_files` and then `read_file` specific files before editing.',
    '',
    `Workspace summary:\n${context.summary}`,
    '',
    `Open editors:\n${context.openEditors.join(', ') || 'None'}`,
    '',
    `Git status:\n${context.gitStatus}`,
    '',
    `Git diff:\n${context.gitDiff}`,
    '',
    `Relevant files:\n${relevantFiles || 'No relevant files selected.'}`,
    observations,
  ].join('\n');

  return { systemPrompt, userPrompt };
}

export function buildPlanningPrompt(
  task: string,
  context: RepoContext,
  existingPlan?: { originalRequest: string; plan: string },
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    'You are operating in Planning Mode inside an IDE.',
    'Your job is to inspect the provided codebase context and produce a descriptive, detailed implementation plan only.',
    'Do not write or modify code. Do not output executable tool JSON.',
    'Ground the plan in the actual repository structure and mention specific files or modules when relevant.',
    'You have creative liberty to propose thoughtful features, product details, UI/UX behavior, empty/loading/error states, polish, and implementation details that the user likely wants but did not explicitly mention.',
    'Separate explicit user requirements from inferred enhancements so the user can revise or decline anything speculative.',
    'Prefer plans that feel complete from a real user workflow perspective: include interaction states, edge cases, accessibility, copy, visual hierarchy, and verification when relevant.',
    'If the request is ambiguous, include a short "Questions" section, but still provide a best-effort plan with sensible defaults.',
    'End by asking whether the user wants to implement the plan or revise it with more details.',
  ].join('\n');

  const relevantFiles = context.relevantFiles
    .map((file) => `### ${file.path}\n${file.content}`)
    .join('\n\n');

  const revisionContext = existingPlan
    ? [
        'Existing planning context:',
        `Original request:\n${existingPlan.originalRequest}`,
        '',
        `Current plan to revise:\n${existingPlan.plan}`,
        '',
        'Use the new user message as requested changes or extra detail, then return a revised complete plan.',
      ].join('\n')
    : '';

  const userPrompt = [
    revisionContext,
    `User request:\n${task}`,
    '',
    `Workspace summary:\n${context.summary}`,
    '',
    `Open editors:\n${context.openEditors.join(', ') || 'None'}`,
    '',
    `Git status:\n${context.gitStatus}`,
    '',
    `Git diff:\n${context.gitDiff}`,
    '',
    `Relevant files:\n${relevantFiles || 'No relevant files selected.'}`,
    '',
    [
      'Return an actionable plan with sections for:',
      '- Goal and intended user experience',
      '- Explicit requirements from the user',
      '- Inferred enhancements and creative additions',
      '- Codebase findings',
      '- UI/UX and interaction details, when relevant',
      '- Implementation steps',
      '- Risks, tradeoffs, and open questions',
      '- Verification',
      '',
      'Be detailed enough that another coding agent could implement the plan without guessing the product behavior.',
    ].join('\n'),
  ].filter(Boolean).join('\n');

  return { systemPrompt, userPrompt };
}
