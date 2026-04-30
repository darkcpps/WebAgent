import type { WorkspaceFilesService } from './files';

export interface FileReplacement {
  path: string;
  current: string;
  next: string;
  summary: string;
  operation?: 'write' | 'delete';
}

export interface LegacyReplacementPatch {
  path?: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  diff?: string;
}

interface ParsedHunk {
  header: string;
  oldStart: number;
  oldLines: string[];
  newLines: string[];
  newNoNewlineAtEnd: boolean;
}

interface ParsedPatchFile {
  path: string;
  oldPath?: string;
  newPath?: string;
  operation: 'modify' | 'create' | 'delete';
  hunks: ParsedHunk[];
}

export class WorkspaceEditEngine {
  constructor(private readonly files: WorkspaceFilesService) {}

  async fullFile(path: string, content: string): Promise<FileReplacement> {
    const current = await this.files.readFile(path);
    return {
      path,
      current,
      next: this.normalizeProviderEscapedMultiline(content),
      summary: `Rewrote ${path}`,
    };
  }

  async exactReplacement(path: string, oldString: string, newString: string, replaceAll = false): Promise<FileReplacement> {
    if (!oldString) {
      throw new Error('edit_file oldString must not be empty.');
    }
    if (oldString === newString) {
      throw new Error('edit_file oldString and newString must differ.');
    }

    const current = await this.files.readFile(path);
    const replacement = this.resolveReplacement(current, oldString, newString, replaceAll);
    return {
      path,
      current,
      next: replacement.next,
      summary: `Replaced ${replacement.count} occurrence${replacement.count === 1 ? '' : 's'} in ${path}`,
    };
  }

  async replaceRange(path: string, startLine: number, endLine: number, content: string): Promise<FileReplacement> {
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new Error(`replace_range requires valid 1-based inclusive startLine/endLine. Received ${startLine}-${endLine}.`);
    }

    const current = await this.files.readFile(path);
    const currentUsesCrlf = current.includes('\r\n');
    const lines = this.toLf(current).split('\n');
    if (startLine > lines.length || endLine > lines.length) {
      throw new Error(`replace_range ${startLine}-${endLine} is outside ${path}, which has ${lines.length} line${lines.length === 1 ? '' : 's'}.`);
    }

    const replacementLines = this.toLf(this.normalizeProviderEscapedMultiline(content)).split('\n');
    const nextLines = [...lines];
    nextLines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
    const nextLf = nextLines.join('\n');
    return {
      path,
      current,
      next: currentUsesCrlf ? this.toCrlf(nextLf) : nextLf,
      summary: `Replaced ${path}:${startLine}-${endLine}`,
    };
  }

  getApplyPatchReadPaths(patches: LegacyReplacementPatch[] = [], patchText?: string): string[] {
    const paths = new Set<string>();
    for (const filePatch of this.parsePatchInputs(patches, patchText)) {
      if (filePatch.operation !== 'create') {
        paths.add(filePatch.path);
      }
    }
    for (const patch of patches) {
      if (patch.path && (!patch.diff || !patch.diff.trim())) {
        paths.add(patch.path);
      }
    }
    return [...paths];
  }

  async applyPatches(patches: LegacyReplacementPatch[] = [], patchText?: string): Promise<FileReplacement[]> {
    const byPath = new Map<string, { originalPath: string; current: string; next: string; summaries: string[]; operation?: 'write' | 'delete'; endsWithNewline: boolean }>();

    const parsedFiles = this.parsePatchInputs(patches, patchText);
    if (parsedFiles.length === 0 && patches.length === 0) {
      throw new Error('apply_patch requires patch text or at least one structured patch.');
    }
    for (const filePatch of parsedFiles) {
      const pathKey = this.normalizePath(filePatch.path);
      let state = byPath.get(pathKey);
      if (!state) {
        const current = await this.readPatchTarget(filePatch);
        state = {
          originalPath: filePatch.path,
          current,
          next: current,
          summaries: [],
          operation: filePatch.operation === 'delete' ? 'delete' : 'write',
          endsWithNewline: current.endsWith('\n'),
        };
      } else if (filePatch.operation === 'delete') {
        state.operation = 'delete';
      }

      const result = this.applyParsedPatchFile(state.next, filePatch, state.endsWithNewline);
      state.next = result.next;
      state.endsWithNewline = result.endsWithNewline;
      state.summaries.push(result.summary);
      byPath.set(pathKey, state);
    }

    for (const patch of patches) {
      if (typeof patch.diff === 'string' && patch.diff.trim()) {
        continue;
      }
      if (!patch.path) {
        throw new Error('apply_patch patch is missing required path.');
      }
      const pathKey = this.normalizePath(patch.path);
      let state = byPath.get(pathKey);
      if (!state) {
        const current = await this.files.readFile(patch.path);
        state = {
          originalPath: patch.path,
          current,
          next: current,
          summaries: [],
          operation: 'write',
          endsWithNewline: current.endsWith('\n'),
        };
      }

      if (typeof patch.oldString !== 'string' || typeof patch.newString !== 'string') {
        throw new Error(`apply_patch for ${patch.path} requires either diff or oldString/newString.`);
      }
      const result = this.resolveReplacement(state.next, patch.oldString, patch.newString, Boolean(patch.replaceAll));
      state.next = result.next;
      state.endsWithNewline = state.next.endsWith('\n');
      state.summaries.push(`legacy replacement matched ${result.count} occurrence${result.count === 1 ? '' : 's'}`);

      byPath.set(pathKey, state);
    }

    return [...byPath.values()].map((state) => ({
      path: state.originalPath,
      current: state.current,
      next: state.next,
      summary: state.summaries.join('; '),
      operation: state.operation,
    }));
  }

  private parsePatchInputs(patches: LegacyReplacementPatch[] = [], patchText?: string): ParsedPatchFile[] {
    const parsed: ParsedPatchFile[] = [];
    if (typeof patchText === 'string' && patchText.trim()) {
      parsed.push(...this.parseUnifiedPatch(patchText));
    }
    for (const patch of patches) {
      if (typeof patch.diff === 'string' && patch.diff.trim()) {
        parsed.push(...this.parseUnifiedPatch(patch.diff, patch.path));
      }
    }
    return parsed;
  }

  private async readPatchTarget(filePatch: ParsedPatchFile): Promise<string> {
    if (filePatch.operation === 'create') {
      try {
        await this.files.readFile(filePatch.path);
        throw new Error(`apply_patch cannot create ${filePatch.path} because it already exists.`);
      } catch (error) {
        if ((error as Error).message.startsWith('apply_patch cannot create')) {
          throw error;
        }
        return '';
      }
    }
    return await this.files.readFile(filePatch.path);
  }

  private applyParsedPatchFile(current: string, filePatch: ParsedPatchFile, currentEndsWithNewline: boolean): { next: string; summary: string; endsWithNewline: boolean } {
    if (filePatch.hunks.length === 0) {
      throw new Error(`apply_patch for ${filePatch.path} did not contain any unified diff hunks.`);
    }

    const currentUsesCrlf = current.includes('\r\n');
    let lines = this.splitPatchLines(current);
    let endsWithNewline = filePatch.operation === 'create' ? true : currentEndsWithNewline;

    for (const hunk of filePatch.hunks) {
      const match = this.findHunk(lines, hunk, filePatch.path);
      const replacement = hunk.newLines;
      lines = [
        ...lines.slice(0, match.start),
        ...replacement,
        ...lines.slice(match.start + hunk.oldLines.length),
      ];
      endsWithNewline = !hunk.newNoNewlineAtEnd;
    }

    const nextLf = this.joinPatchLines(lines, endsWithNewline);
    return {
      next: currentUsesCrlf ? this.toCrlf(nextLf) : nextLf,
      summary: `${filePatch.operation} ${filePatch.path} with ${filePatch.hunks.length} hunk${filePatch.hunks.length === 1 ? '' : 's'}`,
      endsWithNewline,
    };
  }

  private parseUnifiedPatch(diff: string, fallbackPath?: string): ParsedPatchFile[] {
    const lines = this.toLf(this.normalizeProviderEscapedMultiline(diff)).split('\n');
    if (lines.at(-1) === '') {
      lines.pop();
    }
    const files: ParsedPatchFile[] = [];
    let current: { oldPath?: string; newPath?: string; hunks: ParsedHunk[] } | undefined;
    let index = 0;

    const ensureCurrent = (): { oldPath?: string; newPath?: string; hunks: ParsedHunk[] } => {
      current ??= { oldPath: fallbackPath, newPath: fallbackPath, hunks: [] };
      return current;
    };
    const pushCurrent = (): void => {
      if (!current || current.hunks.length === 0) {
        current = undefined;
        return;
      }
      files.push(this.finalizePatchFile(current, fallbackPath));
      current = undefined;
    };

    while (index < lines.length) {
      const line = lines[index];
      if (line.startsWith('diff --git ')) {
        pushCurrent();
        const match = line.match(/^diff --git\s+("?a\/.+?"?)\s+("?b\/.+?"?)$/);
        current = {
          oldPath: match ? this.parsePatchPathToken(match[1]) : fallbackPath,
          newPath: match ? this.parsePatchPathToken(match[2]) : fallbackPath,
          hunks: [],
        };
        index += 1;
        continue;
      }

      if (line.startsWith('--- ')) {
        const target = ensureCurrent();
        target.oldPath = this.parsePatchPathToken(line.slice(4));
        if (index + 1 < lines.length && lines[index + 1].startsWith('+++ ')) {
          target.newPath = this.parsePatchPathToken(lines[index + 1].slice(4));
          index += 2;
          continue;
        }
      }

      if (line.startsWith('@@ ')) {
        const target = ensureCurrent();
        const parsed = this.parseHunk(lines, index);
        target.hunks.push(parsed.hunk);
        index = parsed.nextIndex;
        continue;
      }

      index += 1;
    }

    pushCurrent();
    if (files.length === 0) {
      throw new Error(`apply_patch${fallbackPath ? ` for ${fallbackPath}` : ''} did not contain any unified diff hunks.`);
    }
    return files;
  }

  private parseHunk(lines: string[], startIndex: number): { hunk: ParsedHunk; nextIndex: number } {
    const header = lines[startIndex];
    const match = header.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (!match) {
      throw new Error(`Unsupported unified diff hunk header: ${header}`);
    }

    let index = startIndex + 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let lastSide: 'old' | 'new' | 'both' | undefined;
    let newNoNewlineAtEnd = false;
    while (
      index < lines.length &&
      !lines[index].startsWith('@@ ') &&
      !lines[index].startsWith('diff --git ') &&
      !(lines[index].startsWith('--- ') && index + 1 < lines.length && lines[index + 1].startsWith('+++ '))
    ) {
      const line = lines[index];
      if (line.startsWith(' ')) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
        lastSide = 'both';
      } else if (line.startsWith('-')) {
        oldLines.push(line.slice(1));
        lastSide = 'old';
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1));
        lastSide = 'new';
      } else if (line === '\\ No newline at end of file') {
        if (lastSide === 'new' || lastSide === 'both') {
          newNoNewlineAtEnd = true;
        }
      } else if (line === '') {
        oldLines.push('');
        newLines.push('');
        lastSide = 'both';
      } else {
        throw new Error(`Unsupported unified diff line in ${header}: ${line}`);
      }
      index += 1;
    }

    return {
      hunk: {
        header,
        oldStart: Number(match[1]),
        oldLines,
        newLines,
        newNoNewlineAtEnd,
      },
      nextIndex: index,
    };
  }

  private finalizePatchFile(file: { oldPath?: string; newPath?: string; hunks: ParsedHunk[] }, fallbackPath?: string): ParsedPatchFile {
    const oldPath = this.cleanPatchPath(file.oldPath);
    const newPath = this.cleanPatchPath(file.newPath);
    const operation = oldPath === undefined
      ? 'create'
      : newPath === undefined
        ? 'delete'
        : 'modify';
    const path = operation === 'delete' ? oldPath : newPath;

    if (!path && !fallbackPath) {
      throw new Error('apply_patch could not resolve a target path from patch headers.');
    }

    return {
      path: path ?? fallbackPath!,
      oldPath,
      newPath,
      operation,
      hunks: file.hunks,
    };
  }

  private parsePatchPathToken(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '/dev/null') {
      return undefined;
    }
    const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed.split(/\t/)[0].split(/\s+\d{4}-\d{2}-\d{2}/)[0].trim();
    return this.cleanPatchPath(unquoted);
  }

  private cleanPatchPath(value: string | undefined): string | undefined {
    if (!value || value === '/dev/null') {
      return undefined;
    }
    return value.replace(/\\/g, '/').replace(/^(?:a|b)\//, '');
  }

  private splitPatchLines(value: string): string[] {
    const lf = this.toLf(value);
    if (!lf) {
      return [];
    }
    const lines = lf.split('\n');
    if (lines.at(-1) === '') {
      lines.pop();
    }
    return lines;
  }

  private joinPatchLines(lines: string[], endsWithNewline: boolean): string {
    if (lines.length === 0) {
      return '';
    }
    return `${lines.join('\n')}${endsWithNewline ? '\n' : ''}`;
  }

  private findHunk(lines: string[], hunk: ParsedHunk, path: string): { start: number } {
    if (hunk.oldLines.length === 0) {
      return { start: Math.min(Math.max(0, hunk.oldStart - 1), lines.length) };
    }
    const preferred = Math.max(0, hunk.oldStart - 1);
    const exact = this.findSequence(lines, hunk.oldLines, preferred, false);
    if (exact.length === 1) {
      return { start: exact[0] };
    }
    if (exact.length > 1) {
      throw new Error(`Patch hunk ${hunk.header} in ${path} matched ${exact.length} exact locations; provide more context.`);
    }

    const fuzzy = this.findSequence(lines, hunk.oldLines, preferred, true);
    if (fuzzy.length === 1) {
      return { start: fuzzy[0] };
    }
    if (fuzzy.length > 1) {
      throw new Error(`Patch hunk ${hunk.header} in ${path} matched ${fuzzy.length} whitespace-normalized locations; provide more context.`);
    }

    throw new Error(`Patch hunk ${hunk.header} in ${path} could not be located. Re-read the target lines and retry with replace_range or a full-file edit_file content rewrite.`);
  }

  private findSequence(lines: string[], pattern: string[], preferred: number, trimWhitespace: boolean): number[] {
    if (pattern.length === 0) {
      return [Math.min(preferred, lines.length)];
    }

    const matches: number[] = [];
    const equals = trimWhitespace
      ? (left: string, right: string): boolean => left.trimEnd() === right.trimEnd()
      : (left: string, right: string): boolean => left === right;

    const orderedStarts = [
      preferred,
      ...Array.from({ length: lines.length - pattern.length + 1 }, (_value, index) => index)
        .filter((index) => index !== preferred)
        .sort((left, right) => Math.abs(left - preferred) - Math.abs(right - preferred)),
    ].filter((start) => start >= 0 && start <= lines.length - pattern.length);

    for (const start of orderedStarts) {
      if (pattern.every((line, offset) => equals(lines[start + offset], line))) {
        matches.push(start);
      }
    }

    return matches;
  }

  private resolveReplacement(
    current: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
  ): { next: string; target: string; count: number } {
    const variants = this.buildReplacementVariants(current, oldString, newString);
    const ambiguousCounts: number[] = [];

    for (const variant of variants) {
      const count = this.countOccurrences(current, variant.oldString);
      if (count === 0) {
        continue;
      }

      if (!replaceAll && count > 1) {
        ambiguousCounts.push(count);
        continue;
      }

      const next = replaceAll
        ? current.split(variant.oldString).join(variant.newString)
        : current.replace(variant.oldString, variant.newString);
      return { next, target: variant.oldString, count };
    }

    for (const variant of variants) {
      const loose = this.resolveLineTrimmedReplacement(current, variant.oldString, variant.newString, replaceAll);
      if (loose) {
        return loose;
      }
    }

    if (ambiguousCounts.length > 0) {
      const count = Math.max(...ambiguousCounts);
      throw new Error(`edit_file matched ${count} occurrences; set replaceAll=true or provide more specific text.`);
    }

    throw new Error(
      'edit_file target text not found. Tried exact text plus common provider repairs for escaped newlines, escaped quotes, read_file line prefixes, CRLF/LF differences, and trailing whitespace differences.',
    );
  }

  private resolveLineTrimmedReplacement(
    current: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
  ): { next: string; target: string; count: number } | undefined {
    const oldLines = this.toLf(oldString).split('\n');
    if (oldLines.length < 2) {
      return undefined;
    }

    const currentUsesCrlf = current.includes('\r\n');
    const currentLines = this.toLf(current).split('\n');
    const normalizedOldLines = oldLines.map((line) => line.trimEnd());
    const matches: number[] = [];

    for (let index = 0; index <= currentLines.length - normalizedOldLines.length; index += 1) {
      const matched = normalizedOldLines.every((line, offset) => currentLines[index + offset].trimEnd() === line);
      if (matched) {
        matches.push(index);
      }
    }

    if (matches.length === 0) {
      return undefined;
    }

    if (!replaceAll && matches.length > 1) {
      throw new Error(`edit_file matched ${matches.length} trailing-whitespace-normalized occurrences; set replaceAll=true or provide more specific text.`);
    }

    const nextLines = [...currentLines];
    const replacementLines = this.toLf(newString).split('\n');
    const starts = replaceAll ? [...matches].reverse() : [matches[0]];
    for (const start of starts) {
      nextLines.splice(start, oldLines.length, ...replacementLines);
    }

    const nextLf = nextLines.join('\n');
    return {
      next: currentUsesCrlf ? this.toCrlf(nextLf) : nextLf,
      target: oldString,
      count: matches.length,
    };
  }

  private buildReplacementVariants(
    current: string,
    oldString: string,
    newString: string,
  ): Array<{ oldString: string; newString: string }> {
    const variants: Array<{ oldString: string; newString: string }> = [];
    const add = (oldValue: string, newValue: string): void => {
      if (!oldValue) {
        return;
      }
      if (!variants.some((variant) => variant.oldString === oldValue && variant.newString === newValue)) {
        variants.push({ oldString: oldValue, newString: newValue });
      }
    };

    const basePairs = [
      { oldValue: oldString, newValue: this.normalizeProviderEscapedMultiline(newString, oldString) },
      { oldValue: this.decodeProviderEscapes(oldString), newValue: this.decodeProviderEscapes(newString) },
      { oldValue: this.stripReadLinePrefixes(oldString), newValue: this.stripReadLinePrefixes(newString) },
      {
        oldValue: this.stripReadLinePrefixes(this.decodeProviderEscapes(oldString)),
        newValue: this.stripReadLinePrefixes(this.decodeProviderEscapes(newString)),
      },
    ];

    for (const pair of basePairs) {
      add(pair.oldValue, pair.newValue);

      if (pair.oldValue.includes('\n')) {
        const trimmedOld = pair.oldValue.split(/\r?\n/).map((line) => line.trimEnd()).join('\n');
        const trimmedNew = pair.newValue.split(/\r?\n/).map((line) => line.trimEnd()).join('\n');
        add(trimmedOld, trimmedNew);
        add(this.toCrlf(trimmedOld), this.toCrlf(trimmedNew));
      }

      add(this.toLf(pair.oldValue), this.toLf(pair.newValue));
      if (current.includes('\r\n')) {
        add(this.toCrlf(pair.oldValue), this.toCrlf(pair.newValue));
      }
    }

    return variants;
  }

  normalizeProviderEscapedMultiline(value: string, comparisonText = ''): string {
    const escapedNewlineCount = (value.match(/\\r\\n|\\n|\\r/g) || []).length;
    if (escapedNewlineCount === 0) {
      return value;
    }

    const realNewlineCount = (value.match(/\r\n|\n|\r/g) || []).length;
    if (realNewlineCount >= escapedNewlineCount) {
      return value;
    }

    const decoded = this.decodeProviderEscapes(value);
    if (!/[\r\n]/.test(decoded)) {
      return value;
    }

    const comparisonHasNewlines = /[\r\n]/.test(comparisonText);
    const likelyWholeFile = realNewlineCount === 0 && (escapedNewlineCount >= 1 || decoded.length > 120);
    const likelyMultilineReplacement = comparisonHasNewlines || escapedNewlineCount >= 1;
    return likelyWholeFile || likelyMultilineReplacement ? decoded : value;
  }

  private decodeProviderEscapes(value: string): string {
    return value
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"');
  }

  private stripReadLinePrefixes(value: string): string {
    const lines = value.split(/\r?\n/);
    const prefixedCount = lines.filter((line) => /^\s*\d+:\s?/.test(line)).length;
    if (prefixedCount === 0) {
      return value;
    }
    return lines.map((line) => line.replace(/^\s*\d+:\s?/, '')).join('\n');
  }

  private normalizePath(relativePath: string): string {
    try {
      return this.files.fromRelativePath(relativePath).fsPath.toLowerCase();
    } catch {
      return relativePath.toLowerCase();
    }
  }

  private toLf(value: string): string {
    return value.replace(/\r\n/g, '\n');
  }

  private toCrlf(value: string): string {
    return this.toLf(value).replace(/\n/g, '\r\n');
  }

  private countOccurrences(value: string, needle: string): number {
    if (!needle) {
      return 0;
    }
    return value.split(needle).length - 1;
  }
}
