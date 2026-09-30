import test from 'node:test';
import ts from 'typescript';
import * as prettier from 'prettier';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { compactTypeImports } from './compact.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compact = (source: string, width = 60): string =>
  compactTypeImports(source, 'consumer.tsx', width);
const header = "import type { Message, Conversation, Agent as Assistant } from './models';\n";

function diagnostics(content: string): readonly ts.Diagnostic[] {
  const files = new Map([
    ['/consumer.tsx', content],
    [
      '/models.ts',
      'export interface Message { text: string } export interface Conversation { title: string } export interface Agent { name: string }',
    ],
  ]);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      const text = files.get(name);
      return text === undefined
        ? undefined
        : ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    },
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name),
  };
  const program = ts.createProgram(
    ['/consumer.tsx'],
    {
      noLib: true,
      strict: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    host,
  );
  const source = program.getSourceFile('/consumer.tsx');
  assert.ok(source);
  return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
}

test('compacts named types, resolves aliases, and preserves typechecking', () => {
  const source =
    header +
    'type Row = [Message, Conversation, Assistant];\ninterface Props extends Message { agent: Assistant }\n';
  const output = compact(source);
  assert.equal(
    output,
    "import type * as t from './models';\ntype Row = [t.Message, t.Conversation, t.Agent];\ninterface Props extends t.Message { agent: t.Agent }\n",
  );
  assert.equal(diagnostics(source).length, 0);
  assert.equal(diagnostics(output).length, 0);
  assert.equal(compact(output), output);
});

test('respects printWidth rather than existing line breaks', () => {
  const source =
    "import type {\n  Message,\n  Conversation,\n} from './models';\ntype Row = [Message, Conversation];\n";
  assert.equal(compact(source, 100), source);
  assert.match(compact(source, 40), /import type \* as t/);
  assert.equal(compact(header, header.trimEnd().length), header);
});

test('leaves values, inline types, defaults, and existing namespaces untouched', () => {
  for (const source of [
    "import { Message, Conversation, Agent } from './models';\n",
    "import { type Message, type Conversation, Agent } from './models';\n",
    "import type Models from './models';\n",
    "import type * as models from './models';\n",
    "import type { Message } from 'a-very-long-module-specifier-that-exceeds-the-width';\n",
  ])
    assert.equal(compact(source, 20), source);
});

test('does not rewrite shadowed names, property keys, strings, or ordinary comments', () => {
  const source =
    header +
    'type Box<Message> = { Message: Message; agent: Assistant };\ntype Original = Message;\nconst label = "Message";\n// Message stays a comment\n';
  assert.equal(
    compact(source),
    'import type * as t from \'./models\';\ntype Box<Message> = { Message: Message; agent: t.Agent };\ntype Original = t.Message;\nconst label = "Message";\n// Message stays a comment\n',
  );
});

test('avoids capture by identifiers in nested scopes and imported aliases', () => {
  const source = header + 'type Box<t, t2> = [Message, t, t2];\n';
  assert.equal(
    compact(source),
    "import type * as t3 from './models';\ntype Box<t, t2> = [t3.Message, t, t2];\n",
  );
});

test('handles multiple modules with distinct namespaces', () => {
  const source =
    header +
    "import type { Widget, WidgetConfiguration } from './widgets';\ntype Row = [Message, Widget];\n";
  assert.equal(
    compact(source, 40),
    "import type * as t from './models';\nimport type * as t2 from './widgets';\ntype Row = [t.Message, t2.Widget];\n",
  );
});

test('preserves comments and resolution attributes around the import clause', () => {
  const source = '// leading\n' + header.trimEnd() + ' // trailing\ntype Row = Message;\n';
  assert.equal(
    compact(source),
    "// leading\nimport type * as t from './models'; // trailing\ntype Row = t.Message;\n",
  );
  const attributed =
    header.replace(';', " with { 'resolution-mode': 'import' };") + 'type Row = Message;\n';
  assert.match(
    compact(attributed),
    /import type \* as t from '\.\/models' with \{ 'resolution-mode': 'import' \};/,
  );
  const commented = header.replace('Message,', 'Message, /* retained */');
  assert.equal(compact(commented), commented);
});

test('rewrites documentation types and qualified type queries', () => {
  const source =
    header +
    '/** @param {Message} message */\nfunction show(message: Message): void {}\ntype Field = typeof Message.field;\n';
  assert.equal(
    compact(source),
    "import type * as t from './models';\n/** @param {t.Message} message */\nfunction show(message: t.Message): void {}\ntype Field = typeof t.Message.field;\n",
  );
});

test('skips re-exported bindings rather than producing invalid export syntax', () => {
  for (const statement of [
    'export type { Message };',
    'export type { Message as PublicMessage };',
    'export { Message as PublicMessage };',
  ]) {
    const source = header + statement + '\ntype Row = Conversation;\n';
    assert.equal(compact(source), source);
  }
});

test('skips unsafe value uses and malformed input', () => {
  for (const use of ['const row = { Message };', 'const row = Message;', 'type Row = ;']) {
    const source = header + use + '\n';
    assert.equal(compact(source), source);
  }
  const stringExport = "import type { 'strange-name' as Message, Conversation } from './models';\n";
  assert.equal(compact(stringExport, 20), stringExport);
});

test('skips conflicting declarations and documentation links', () => {
  for (const suffix of [
    'interface Message {}\ntype Row = Message;\n',
    "import type { Message } from './other';\ntype Row = Message;\n",
    '/** {@link Message} */\ntype Row = Conversation;\n',
  ])
    assert.equal(compact(header + suffix), header + suffix);
});

test('qualifies default export aliases and namespace members', () => {
  const source =
    "import type { default as Message, Conversation, Agent as Assistant } from './models';\ntype Row = [Message, Assistant.Options];\n";
  assert.equal(
    compact(source),
    "import type * as t from './models';\ntype Row = [t.default, t.Agent.Options];\n",
  );
});

test('output stays compact after Prettier formats it', async () => {
  const source = await prettier.format(
    header + 'type Row = [Message, Conversation, Assistant];\n',
    { parser: 'typescript', printWidth: 60, singleQuote: true },
  );
  const output = compact(source);
  assert.ok(
    await prettier.check(output, { parser: 'typescript', printWidth: 60, singleQuote: true }),
  );
  assert.equal(
    compact(
      await prettier.format(output, { parser: 'typescript', printWidth: 60, singleQuote: true }),
    ),
    output,
  );
});

test('CLI opt-in, check-only mode, sorting, ignore marker, and idempotence', async () => {
  const directory = await mkdtemp(join(ROOT, 'client/src/.compact-imports-test-'));
  const file = join(directory, 'fixture.ts');
  const source =
    "import type { Message, Conversation, AgentConfiguration, AgentPermission, AgentCapability } from './models';\nimport { useState } from 'react';\n\ntype Row = Message;\n";
  const run = (...flags: string[]) =>
    spawnSync(process.execPath, ['scripts/sort-imports.mts', ...flags, file], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  try {
    await writeFile(file, source);
    const normal = run();
    assert.equal(normal.status, 0, normal.stderr);
    const sorted = await readFile(file, 'utf8');
    assert.match(sorted, /import type \{/);
    const check = run('--compact-types', '--check');
    assert.equal(check.status, 1, check.stderr);
    assert.equal(await readFile(file, 'utf8'), sorted);
    const converted = run('--compact-types');
    assert.equal(converted.status, 0, converted.stderr);
    const output = await readFile(file, 'utf8');
    assert.equal(
      output,
      "import { useState } from 'react';\nimport type * as t from './models';\n\ntype Row = t.Message;\n",
    );
    assert.equal(run('--compact-types', '--check').status, 0);
    assert.equal(run('--check').status, 0);
    await writeFile(file, '// sort-imports-ignore\n' + source);
    assert.equal(run('--compact-types').status, 0);
    assert.equal(await readFile(file, 'utf8'), '// sort-imports-ignore\n' + source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
