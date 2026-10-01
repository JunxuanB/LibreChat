import test from 'node:test';
import ts from 'typescript';
import * as prettier from 'prettier';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { compactImports } from './compact.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compact = (source: string, width = 60): string =>
  compactImports(source, 'consumer.tsx', width);
const header = "import type { Message, Conversation, Agent as Assistant } from './models';\n";

function diagnostics(
  content: string,
  model = 'export interface Message { text: string } export interface Conversation { title: string } export interface Agent { name: string }',
): readonly ts.Diagnostic[] {
  const files = new Map([
    ['/consumer.tsx', content],
    ['/models.ts', model],
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
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
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

test('leaves inline types, defaults, and existing namespaces untouched', () => {
  for (const source of [
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

test('preserves synthetic default aliases and their type namespaces', () => {
  const source =
    "import type { default as Message, Conversation } from './models';\ntype Row = [Message, Conversation, Message.Conversation];\n";
  const model =
    'declare class Message { text: string } declare namespace Message { interface Conversation { title: string } } export = Message;';
  assert.equal(diagnostics(source, model).length, 0);
  const output = compact(source);
  assert.equal(output, source);
  assert.equal(diagnostics(output, model).length, 0);
});

test('qualifies namespace members of ordinary named aliases', () => {
  const source = header + 'type Row = [Message, Assistant.Options];\n';
  assert.equal(
    compact(source),
    "import type * as t from './models';\ntype Row = [t.Message, t.Agent.Options];\n",
  );
});

test('compacts consistently with Windows, POSIX, and relative filenames', () => {
  const source = header + 'type Row = [Message, Conversation, Assistant];\n';
  const expected = compact(source);
  assert.notEqual(expected, source);
  for (const file of [
    'C:\\repo\\consumer.tsx',
    'C:/repo/consumer.tsx',
    '/repo/consumer.tsx',
    'src\\consumer.tsx',
    'src/consumer.tsx',
  ])
    assert.equal(compactImports(source, file, 60), expected, file);
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

test('normal CLI and pre-commit cleanup enforce value and type compaction', async () => {
  const directory = await mkdtemp(join(ROOT, 'client/src/.compact-imports-test-'));
  const file = join(directory, 'fixture.ts');
  const source =
    "import { useState } from 'react';\nimport type { Message, Conversation, AgentConfiguration, AgentPermission, AgentCapability } from './models';\n\ntype Row = Message;\n";
  const run = (...flags: string[]) =>
    spawnSync(process.execPath, ['scripts/sort-imports.mts', ...flags, file], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  try {
    await writeFile(file, source);
    const check = run('--check');
    assert.equal(check.status, 1, check.stderr);
    assert.equal(await readFile(file, 'utf8'), source);
    const staticCheck = (): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, ['scripts/static-checks.mts', '--only', 'imports', file], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    const rejected = staticCheck();
    assert.equal(rejected.status, 1, String(rejected.stderr));
    assert.equal(await readFile(file, 'utf8'), source);
    const converted = run();
    assert.equal(converted.status, 0, converted.stderr);
    const output = await readFile(file, 'utf8');
    assert.equal(
      output,
      "import { useState } from 'react';\nimport type * as t from './models';\n\ntype Row = t.Message;\n",
    );
    assert.equal(run('--check').status, 0);
    const accepted = staticCheck();
    assert.equal(accepted.status, 0, String(accepted.stderr));
    assert.equal(run().status, 0);
    assert.equal(await readFile(file, 'utf8'), output);

    await writeFile(file, source);
    const hooks: { '*.{js,jsx,ts,tsx}': string[] } = createRequire(import.meta.url)(
      join(ROOT, '.husky/lint-staged.config.js'),
    );
    const [command, ...args] = hooks['*.{js,jsx,ts,tsx}'][0].split(' ');
    assert.equal(command, 'node');
    const hook = spawnSync(process.execPath, [...args, file], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(await readFile(file, 'utf8'), output);

    const values = source.replace('import type {', 'import {');
    await writeFile(file, values);
    assert.equal(run('--check').status, 1);
    assert.equal(staticCheck().status, 1);
    const valueHook = spawnSync(process.execPath, [...args, file], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(valueHook.status, 0, valueHook.stderr);
    assert.equal(
      await readFile(file, 'utf8'),
      output.replace('import type * as t', 'import * as m').replace('t.Message', 'm.Message'),
    );
    assert.equal(run('--check').status, 0);
    assert.equal(staticCheck().status, 0);

    await writeFile(file, '// sort-imports-ignore\n' + source);
    assert.equal(run('--check').status, 0);
    assert.equal(run().status, 0);
    assert.equal(await readFile(file, 'utf8'), '// sort-imports-ignore\n' + source);

    const longImport = source.split('\n')[1] + '\n';
    for (const exempt of [
      longImport + 'export type { Message };\n',
      longImport.replace('Message,', 'Message, /* retained */'),
      "import type { default as Message, Conversation, AgentConfiguration, AgentPermission } from './models';\n",
      "import type { Message, Conversation } from './models';\n",
    ]) {
      await writeFile(file, exempt);
      assert.equal(run('--check').status, 0, exempt);
      assert.equal(run().status, 0, exempt);
      assert.equal(await readFile(file, 'utf8'), exempt);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function executeModule(source: string, model: string): Promise<string> {
  const directory = await mkdtemp(join(ROOT, 'scripts/imports/.runtime-imports-'));
  const emit = (text: string): string =>
    ts.transpileModule(text, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.React,
        jsxFactory: 'render',
      },
    }).outputText;
  try {
    await writeFile(join(directory, 'models.mjs'), emit(model));
    await writeFile(
      join(directory, 'consumer.mjs'),
      emit(source.replaceAll("'./models'", "'./models.mjs'")),
    );
    const result = spawnSync(process.execPath, [join(directory, 'consumer.mjs')], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('compacts runtime aliases, classes, callbacks and object shorthand without capturing locals', () => {
  const source =
    "import { Message, Conversation, Agent as Assistant } from './models';\n" +
    'type Row = Message;\nconst row = new Message();\nconst props = { Assistant };\nconst callback = Conversation;\nfunction scoped<Message>(value: Message) { return value; }\n';
  assert.equal(
    compact(source),
    "import * as m from './models';\n" +
      'type Row = m.Message;\nconst row = new m.Message();\nconst props = { Assistant: m.Agent };\nconst callback = m.Conversation;\nfunction scoped<Message>(value: Message) { return value; }\n',
  );
});

test('preserves unbound call and tag receivers, including optional and wrapped calls', async () => {
  const source =
    "import { receiver, tag, receiver as call } from './models';\n" +
    'console.log(JSON.stringify([receiver(), receiver?.(), (receiver)(), (receiver!)(), call(), tag`value`, (tag)`value`]));\n';
  const model =
    'export function receiver() { return this === undefined; } export function tag() { return this === undefined; }';
  const output = compact(source, 40);
  assert.match(output, /\(void 0, m.receiver\)\(\)/);
  assert.match(output, /\(void 0, m.receiver\)\?\.\(\)/);
  const before = await executeModule(source, model);
  assert.equal(before.trim(), '[true,true,true,true,true,true,true]');
  assert.equal(await executeModule(output, model), before);
  assert.equal(
    diagnostics(
      "import { receiver, other } from './models';\nreceiver();\n",
      'export function receiver(this: void): void {} export const other = 1;',
    ).length,
    0,
  );
  assert.equal(
    diagnostics(
      compact("import { receiver, other } from './models';\nreceiver();\n", 30),
      'export function receiver(this: void): void {} export const other = 1;',
    ).length,
    0,
  );
});

test('preserves receivers through generic instantiation expressions and template tags', async () => {
  const source =
    "import { receiver, tag, receiver as call } from './models';\n" +
    'console.log(JSON.stringify([receiver<string>(), (receiver<string>)(), (receiver<string>)?.(), ((receiver<string>)!)(), (call<number>)(), (tag<string>)`value`]));\n';
  const model =
    'export function receiver<T>(this: void) { return this === undefined; } export function tag<T>(this: void) { return this === undefined; }';
  const output = compact(source, 40);
  assert.match(output, /\(void 0, m.receiver\)/);
  const before = await executeModule(source, model);
  assert.equal(before.trim(), '[true,true,true,true,true,true]');
  assert.equal(await executeModule(output, model), before);
  const typed =
    "import { receiver, other } from './models';\n(receiver<string>)();\n(receiver<typeof other>)();\n(receiver as typeof receiver)();\n";
  const typedModel = 'export function receiver<T>(this: void): void {} export const other = 1;';
  assert.equal(diagnostics(typed, typedModel).length, 0);
  assert.equal(diagnostics(compact(typed, 30), typedModel).length, 0);
});

test('expands __proto__ shorthand as an own property, including escaped identifiers', async () => {
  for (const name of ['__proto__', '\\u005f\\u005fproto__']) {
    const source =
      "import { value as __proto__, other, another } from './models';\n" +
      `const obj = { ${name} };\nconsole.log(JSON.stringify([Object.hasOwn(obj, '__proto__'), Object.getPrototypeOf(obj) === Object.prototype, Object.keys(obj), obj['__proto__']]));\n`;
    const output = compact(source, 40);
    assert.match(output, /\['__proto__'\]: m.value/);
    for (const value of ['{ inherited: true }', 'null', '7']) {
      const model = `export const value = ${value}; export const other = 1; export const another = 2;`;
      const before = await executeModule(source, model);
      assert.ok(before.startsWith('[true,true,'));
      assert.equal(await executeModule(output, model), before);
    }
  }
});

test('preserves live bindings, existing member receivers, constructors and shorthand keys', async () => {
  const source =
    "import { counter, increment, service, Thing } from './models';\n" +
    'const before = counter;\nincrement();\nconst props = { counter };\nconsole.log(JSON.stringify([before, counter, props.counter, service.read(), new Thing().value]));\n';
  const model =
    'export let counter = 1; export function increment() { counter++; } export const service = { value: 3, read() { return this.value; } }; export class Thing { value = 4; }';
  const output = compact(source);
  assert.match(output, /counter: m.counter/);
  assert.match(output, /m.service.read\(\)/);
  const before = await executeModule(source, model);
  assert.equal(before.trim(), '[1,2,2,3,4]');
  assert.equal(await executeModule(output, model), before);
});

test('updates opening, closing and member JSX tags without changing attributes or intrinsic tags', async () => {
  const source =
    "import { Button as Primary, Panel, Group } from './models';\n" +
    'const render = (component, props, ...children) => [component, props, children];\n' +
    'const view = <Primary Panel={Panel}><Group.Item /><div>body</div></Primary>;\nconsole.log(JSON.stringify(view));\n';
  const model =
    "export const Button = 'button'; export const Panel = 'panel'; export const Group = { Item: 'item' };";
  const output = compact(source, 40);
  assert.match(output, /<m.Button Panel=\{m.Panel\}>/);
  assert.match(output, /<m.Group.Item \/>/);
  assert.match(output, /<\/m.Button>/);
  assert.match(output, /<div>body<\/div>/);
  assert.equal(await executeModule(output, model), await executeModule(source, model));
});

test('keeps short runtime imports, mixed inline types, defaults, comments, exports and unsafe writes', () => {
  const runtime = "import { Message, Conversation, Agent as Assistant } from './models';\n";
  assert.equal(compact(runtime, 100), runtime);
  for (const suffix of [
    'export { Message };\n',
    'export { Message as PublicMessage };\n',
    'Message = value;\n',
    'Message += value;\n',
    'Message++;\n',
    '++Message;\n',
    '({ Message } = value);\n',
    '[Message] = value;\n',
    'for (Message of values) {}\n',
    'delete Message;\n',
    "eval('Message');\n",
    "(eval)('Message');\n",
    '/** {@link Message} */\n',
  ])
    assert.equal(compact(runtime + suffix), runtime + suffix, suffix);
  for (const source of [
    runtime.replace('Message,', 'Message, /* retained */'),
    "import { default as Message, Conversation, Agent } from './models';\n",
    "import Message, { Conversation, Agent, Configuration } from './models';\n",
    "import { type Message, Conversation, Agent } from './models';\n",
  ])
    assert.equal(compact(source), source);
});

test('preserves direct hook calls so hook lint remains effective', () => {
  for (const call of ['useState()', '(useState)()', 'useState?.()', '(useState<number>)()']) {
    const source = "import { useState, useEffect, useCallback } from 'react';\n" + call + ';\n';
    assert.equal(compact(source, 30), source);
  }
});

test('preserves side-effect imports and formatting around runtime compaction', async () => {
  const source =
    "import './register';\nimport { Widget, WidgetConfiguration } from './widgets';\nWidget();\n";
  const output = compact(source, 40);
  assert.ok(output.startsWith("import './register';\nimport * as m from './widgets';"));
  const formatted = await prettier.format(output, {
    parser: 'typescript',
    printWidth: 100,
    singleQuote: true,
  });
  assert.equal(compact(formatted), formatted);
  assert.match(formatted, /\(void 0, m.Widget\)\(\)/);
});

test('handles JavaScript, JSX and Windows runtime import paths, with collision-free namespaces', () => {
  const source =
    "import { Message, Conversation, Agent as Assistant } from './models';\n" +
    'const m = 1;\nfunction inner(m2) { return [Message, m2]; }\nconst props = { Assistant };\n';
  const output = compact(source);
  assert.match(output, /import \* as m3/);
  for (const file of ['consumer.js', 'consumer.jsx', 'consumer.ts', 'C:\\repo\\consumer.tsx'])
    assert.equal(compactImports(source, file, 60), output, file);
  assert.equal(compact(output), output);
});

test('type and runtime namespaces stay distinct and stable after formatting', async () => {
  const source =
    "import { Widget, WidgetConfiguration } from './widgets';\n" +
    header +
    'const value: Message = Widget;\n';
  const output = compact(source, 40);
  assert.match(output, /import \* as m from '\.\/widgets'/);
  assert.match(output, /import type \* as t from '\.\/models'/);
  assert.match(output, /const value: t.Message = m.Widget/);
  const formatted = await prettier.format(output, {
    parser: 'typescript',
    printWidth: 100,
    singleQuote: true,
  });
  assert.equal(compact(formatted), formatted);
});
