import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as vscode from 'vscode';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpServerStatus {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  ok: boolean;
  disabled?: boolean;
  tools: McpToolInfo[];
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class McpStdioClient {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private initialized = false;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly name: string,
    private readonly config: McpServerConfig,
  ) {}

  async listTools(): Promise<McpToolInfo[]> {
    await this.ensureStarted();
    const result = await this.request('tools/list', {}, 20000);
    const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
    return tools
      .filter(isRecord)
      .map((tool) => ({
        server: this.name,
        name: String(tool.name ?? ''),
        description: typeof tool.description === 'string' ? tool.description : undefined,
        inputSchema: tool.inputSchema,
      }))
      .filter((tool) => tool.name);
  }

  async callTool(toolName: string, args: Record<string, unknown> = {}, timeoutMs = 60000): Promise<unknown> {
    await this.ensureStarted();
    return await this.request('tools/call', { name: toolName, arguments: args }, timeoutMs);
  }

  dispose(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server ${this.name} stopped before request ${id} completed.`));
    }
    this.pending.clear();
    this.process?.kill();
    this.process = undefined;
    this.initialized = false;
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.process) {
      const env = { ...process.env, ...(this.config.env ?? {}) };
      const command = expandEnvironmentVariables(this.config.command);
      const args = (this.config.args ?? []).map(expandEnvironmentVariables);
      this.process = spawn(command, args, {
        cwd: this.config.cwd,
        env,
        shell: shouldUseShell(command),
      });

      this.process.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk.toString('utf8')));
      this.process.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) {
          console.warn(`[mcp:${this.name}] ${text}`);
        }
      });
      this.process.on('exit', (code) => {
        const message = `MCP server ${this.name} exited with code ${code ?? 'unknown'}.`;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(message));
        }
        this.pending.clear();
        this.process = undefined;
        this.initialized = false;
      });
    }

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'webagent-code',
        version: '0.1.0',
      },
    }, 20000);
    this.sendNotification('notifications/initialized', {});
    this.initialized = true;
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;

    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd >= 0 && /^content-length:/i.test(this.buffer.slice(0, headerEnd))) {
        const header = this.buffer.slice(0, headerEnd);
        const contentLengthMatch = /content-length:\s*(\d+)/i.exec(header);
        if (!contentLengthMatch) {
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }

        const length = Number(contentLengthMatch[1]);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (this.buffer.length < bodyEnd) {
          return;
        }

        const body = this.buffer.slice(bodyStart, bodyEnd);
        this.buffer = this.buffer.slice(bodyEnd);
        this.parseMessageBody(body);
        continue;
      }

      const lineEnd = this.buffer.search(/\r?\n/);
      if (lineEnd < 0) {
        return;
      }

      const line = this.buffer.slice(0, lineEnd).trim();
      this.buffer = this.buffer.slice(this.buffer[lineEnd] === '\r' && this.buffer[lineEnd + 1] === '\n' ? lineEnd + 2 : lineEnd + 1);
      if (line) {
        this.parseMessageBody(line);
      }
    }
  }

  private parseMessageBody(body: string): void {
    try {
      this.handleMessage(JSON.parse(body) as JsonRpcMessage);
    } catch (error) {
      console.warn(`[mcp:${this.name}] Failed to parse JSON-RPC message: ${(error as Error).message}`);
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (typeof message.id !== 'number') {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message || `MCP request ${message.id} failed.`));
      return;
    }

    pending.resolve(message.result);
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${this.name}.${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write(message);
    return await promise;
  }

  private sendNotification(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: JsonRpcMessage): void {
    if (!this.process) {
      throw new Error(`MCP server ${this.name} is not running.`);
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

export class McpManager implements vscode.Disposable {
  private clients = new Map<string, McpStdioClient>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async listTools(): Promise<McpToolInfo[]> {
    const configs = await this.loadServerConfigs();
    const results: McpToolInfo[] = [];
    const errors: string[] = [];

    for (const [name, config] of Object.entries(configs)) {
      try {
        const client = this.getClient(name, config);
        results.push(...await client.listTools());
      } catch (error) {
        errors.push(`${name}: ${(error as Error).message}`);
      }
    }

    if (results.length === 0 && errors.length > 0) {
      throw new Error(`No MCP tools loaded. ${errors.join('; ')}`);
    }

    return results;
  }

  async getServerConfigs(): Promise<Record<string, McpServerConfig>> {
    return await this.loadServerConfigs();
  }

  async getAllServerConfigs(): Promise<Record<string, McpServerConfig>> {
    return await this.loadAllServerConfigs();
  }

  async checkServers(): Promise<McpServerStatus[]> {
    const configs = await this.loadAllServerConfigs();
    const disabledServers = this.getDisabledServerSet();
    const statuses: McpServerStatus[] = [];

    for (const [name, config] of Object.entries(configs).sort(([left], [right]) => left.localeCompare(right))) {
      if (disabledServers.has(name)) {
        statuses.push({
          name,
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd,
          ok: false,
          disabled: true,
          tools: [],
        });
        continue;
      }

      try {
        const client = this.getClient(name, config);
        const tools = await client.listTools();
        statuses.push({
          name,
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd,
          ok: true,
          tools,
        });
      } catch (error) {
        statuses.push({
          name,
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd,
          ok: false,
          tools: [],
          error: (error as Error).message,
        });
      }
    }

    return statuses;
  }

  async callTool(server: string, tool: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const configs = await this.loadServerConfigs();
    const config = configs[server];
    if (!config) {
      const available = Object.keys(configs).sort().join(', ') || 'none';
      throw new Error(`Unknown MCP server "${server}". Available servers: ${available}.`);
    }

    const client = this.getClient(server, config);
    return await client.callTool(tool, args, timeoutMs);
  }

  getDisabledServers(): string[] {
    return [...this.getDisabledServerSet()].sort((left, right) => left.localeCompare(right));
  }

  async setServerDisabled(server: string, disabled: boolean): Promise<void> {
    const name = server.trim();
    if (!name) {
      return;
    }

    const disabledServers = this.getDisabledServerSet();
    if (disabled) {
      disabledServers.add(name);
      this.clients.get(name)?.dispose();
      this.clients.delete(name);
    } else {
      disabledServers.delete(name);
    }

    await vscode.workspace
      .getConfiguration('webagentCode')
      .update('mcp.disabledServers', [...disabledServers].sort((left, right) => left.localeCompare(right)), vscode.ConfigurationTarget.Global);
  }

  dispose(): void {
    for (const client of this.clients.values()) {
      client.dispose();
    }
    this.clients.clear();
  }

  private getClient(name: string, config: McpServerConfig): McpStdioClient {
    const existing = this.clients.get(name);
    if (existing) {
      return existing;
    }

    const client = new McpStdioClient(name, config);
    this.clients.set(name, client);
    return client;
  }

  private async loadServerConfigs(): Promise<Record<string, McpServerConfig>> {
    const configs = await this.loadAllServerConfigs();
    const disabledServers = this.getDisabledServerSet();
    return Object.fromEntries(Object.entries(configs).filter(([name]) => !disabledServers.has(name)));
  }

  private async loadAllServerConfigs(): Promise<Record<string, McpServerConfig>> {
    const configuration = vscode.workspace.getConfiguration('webagentCode');
    if (!configuration.get<boolean>('mcp.enabled', true)) {
      return {};
    }

    return {
      ...this.loadCodexConfig(),
      ...this.loadJsonMcpConfigs(),
      ...this.normalizeConfiguredServers(configuration.get<Record<string, unknown>>('mcp.servers', {})),
    };
  }

  private getDisabledServerSet(): Set<string> {
    const configuration = vscode.workspace.getConfiguration('webagentCode');
    const disabledServers = configuration.get<string[]>('mcp.disabledServers', []);
    return new Set((disabledServers ?? []).map((name) => name.trim()).filter(Boolean));
  }

  private normalizeConfiguredServers(value: Record<string, unknown>): Record<string, McpServerConfig> {
    const result: Record<string, McpServerConfig> = {};
    for (const [name, rawConfig] of Object.entries(value ?? {})) {
      if (!isRecord(rawConfig) || typeof rawConfig.command !== 'string') {
        continue;
      }
      result[name] = {
        command: rawConfig.command,
        args: Array.isArray(rawConfig.args) ? rawConfig.args.map(String) : undefined,
        env: isStringRecord(rawConfig.env) ? rawConfig.env : undefined,
        cwd: typeof rawConfig.cwd === 'string'
          ? rawConfig.cwd
          : typeof rawConfig.working_directory === 'string'
            ? rawConfig.working_directory
            : undefined,
      };
    }
    return result;
  }

  private loadJsonMcpConfigs(): Record<string, McpServerConfig> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const candidates = [
      workspaceRoot ? path.join(workspaceRoot, '.vscode', 'mcp.json') : undefined,
      workspaceRoot ? path.join(workspaceRoot, '.cursor', 'mcp.json') : undefined,
      path.join(os.homedir(), '.cursor', 'mcp.json'),
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json') : undefined,
    ].filter((candidate): candidate is string => Boolean(candidate));

    const result: Record<string, McpServerConfig> = {};
    for (const filePath of candidates) {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
        const servers = isRecord(parsed.mcpServers)
          ? parsed.mcpServers
          : isRecord(parsed.servers)
            ? parsed.servers
            : {};
        Object.assign(result, this.normalizeConfiguredServers(resolveConfigVariables(servers)));
      } catch (error) {
        console.warn(`[mcp] Failed to parse ${filePath}: ${(error as Error).message}`);
      }
    }

    return result;
  }

  private loadCodexConfig(): Record<string, McpServerConfig> {
    const result: Record<string, McpServerConfig> = {};
    const candidates = [
      path.join(os.homedir(), '.codex', 'config.toml'),
      path.join(this.context.globalStorageUri.fsPath, 'config.toml'),
    ];

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      candidates.unshift(path.join(workspaceRoot, '.codex', 'config.toml'));
    }

    for (const filePath of candidates) {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      try {
        Object.assign(result, this.parseCodexMcpServers(fs.readFileSync(filePath, 'utf8')));
      } catch (error) {
        console.warn(`[mcp] Failed to parse ${filePath}: ${(error as Error).message}`);
      }
    }

    return result;
  }

  private parseCodexMcpServers(text: string): Record<string, McpServerConfig> {
    const result: Record<string, McpServerConfig> = {};
    let currentName: string | undefined;
    let current: Partial<McpServerConfig> | undefined;
    let inEnvSection = false;

    const commit = (): void => {
      if (currentName && current?.command) {
        result[currentName] = {
          command: current.command,
          args: current.args,
          env: current.env,
          cwd: current.cwd,
        };
      }
    };

    for (const rawLine of text.split(/\r?\n/)) {
      const line = stripTomlComment(rawLine).trim();
      if (!line) {
        continue;
      }

      const serverSection = /^\[mcp_servers\.([^\].]+)\]$/.exec(line);
      const envSection = /^\[mcp_servers\.([^\].]+)\.env\]$/.exec(line);
      if (serverSection || envSection) {
        commit();
        currentName = unquoteToml((serverSection ?? envSection)?.[1].trim() ?? '');
        current = result[currentName] ? { ...result[currentName] } : {};
        inEnvSection = Boolean(envSection);
        continue;
      }

      if (!current) {
        continue;
      }

      const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
      if (!pair) {
        continue;
      }

      const [, key, rawValue] = pair;
      if (inEnvSection) {
        current.env = {
          ...(current.env ?? {}),
          [key]: parseTomlString(rawValue),
        };
      } else if (key === 'command') {
        current.command = parseTomlString(rawValue);
      } else if (key === 'args') {
        current.args = parseTomlStringArray(rawValue);
      } else if (key === 'cwd' || key === 'working_directory') {
        current.cwd = parseTomlString(rawValue);
      } else if (key === 'env') {
        current.env = parseTomlInlineStringTable(rawValue);
      }
    }

    commit();
    return result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function stripTomlComment(line: string): string {
  let inString = false;
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== '\\') {
      if (!inString) {
        inString = true;
        quote = char;
      } else if (quote === char) {
        inString = false;
      }
      continue;
    }
    if (char === '#' && !inString) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlString(value: string): string {
  return unquoteToml(value.trim());
}

function unquoteToml(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

function parseTomlStringArray(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return undefined;
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  return splitTomlList(inner).map((entry) => parseTomlString(entry));
}

function parseTomlInlineStringTable(value: string): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const entry of splitTomlList(trimmed.slice(1, -1))) {
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(entry.trim());
    if (pair) {
      result[pair[1]] = parseTomlString(pair[2]);
    }
  }
  return result;
}

function splitTomlList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inString = false;
  let quote = '';

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
      if (!inString) {
        inString = true;
        quote = char;
      } else if (quote === char) {
        inString = false;
      }
    }

    if (char === ',' && !inString) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function resolveConfigVariables(value: Record<string, unknown>): Record<string, unknown> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const replacements: Record<string, string> = {
    '${workspaceFolder}': workspaceRoot,
    '${workspaceRoot}': workspaceRoot,
    '${userHome}': os.homedir(),
    '~': os.homedir(),
  };

  const visit = (entry: unknown): unknown => {
    if (typeof entry === 'string') {
      let result = entry;
      for (const [needle, replacement] of Object.entries(replacements)) {
        if (needle === '~' && result !== '~' && !result.startsWith('~/') && !result.startsWith('~\\')) {
          continue;
        }
        result = result.split(needle).join(replacement);
      }
      return result;
    }
    if (Array.isArray(entry)) {
      return entry.map(visit);
    }
    if (isRecord(entry)) {
      return Object.fromEntries(Object.entries(entry).map(([key, nested]) => [key, visit(nested)]));
    }
    return entry;
  };

  return visit(value) as Record<string, unknown>;
}

function expandEnvironmentVariables(value: string): string {
  let expanded = value.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? process.env[name.toUpperCase()] ?? '');
  expanded = expanded.replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] ?? process.env[name.toUpperCase()] ?? '');
  return expanded;
}

function shouldUseShell(command: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  const basename = path.basename(command).toLowerCase();
  if (basename === 'cmd.exe' || basename === 'cmd') {
    return false;
  }

  return basename.endsWith('.cmd') || basename.endsWith('.bat');
}
