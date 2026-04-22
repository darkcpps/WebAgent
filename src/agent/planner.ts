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
