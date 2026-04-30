import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { WorkspaceEditEngine } from '../editEngine';
import type { WorkspaceFilesService } from '../files';

class FakeFiles {
  constructor(private readonly files: Record<string, string>) {}

  async readFile(path: string): Promise<string> {
    if (!(path in this.files)) {
      throw new Error(`Missing file: ${path}`);
    }
    return this.files[path];
  }

  fromRelativePath(path: string): { fsPath: string } {
    return { fsPath: path };
  }
}

function engine(files: Record<string, string>): WorkspaceEditEngine {
  return new WorkspaceEditEngine(new FakeFiles(files) as unknown as WorkspaceFilesService);
}

describe('WorkspaceEditEngine apply_patch', () => {
  it('modifies one file from standard git patch text', async () => {
    const replacements = await engine({ 'src/app.ts': 'one\ntwo\nthree\n' }).applyPatches([], [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '',
    ].join('\n'));

    assert.equal(replacements.length, 1);
    assert.equal(replacements[0].path, 'src/app.ts');
    assert.equal(replacements[0].next, 'one\nTWO\nthree\n');
  });

  it('applies multiple files and multiple hunks without git', async () => {
    const replacements = await engine({
      'a.txt': 'a\nb\nc\nd\n',
      'b.txt': 'x\ny\nz\n',
    }).applyPatches([], [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
      '@@ -3,2 +3,2 @@',
      ' c',
      '-d',
      '+D',
      'diff --git a/b.txt b/b.txt',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1,3 +1,3 @@',
      ' x',
      '-y',
      '+Y',
      ' z',
      '',
    ].join('\n'));

    assert.deepEqual(replacements.map((entry) => [entry.path, entry.next]), [
      ['a.txt', 'a\nB\nc\nD\n'],
      ['b.txt', 'x\nY\nz\n'],
    ]);
  });

  it('creates and deletes files from dev-null patch headers', async () => {
    const replacements = await engine({ 'old.txt': 'remove me\n' }).applyPatches([], [
      'diff --git a/new.txt b/new.txt',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+created',
      'diff --git a/old.txt b/old.txt',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-remove me',
      '',
    ].join('\n'));

    assert.deepEqual(replacements.map((entry) => [entry.path, entry.operation, entry.next]), [
      ['new.txt', 'write', 'created\n'],
      ['old.txt', 'delete', ''],
    ]);
  });

  it('preserves CRLF line endings for existing files', async () => {
    const replacements = await engine({ 'win.txt': 'a\r\nb\r\n' }).applyPatches([], [
      '--- a/win.txt',
      '+++ b/win.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
      '',
    ].join('\n'));

    assert.equal(replacements[0].next, 'a\r\nB\r\n');
  });

  it('fails stale hunks before any write operation is returned', async () => {
    await assert.rejects(
      () => engine({ 'stale.txt': 'current\n' }).applyPatches([], [
        '--- a/stale.txt',
        '+++ b/stale.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n')),
      /could not be located/,
    );
  });
});
