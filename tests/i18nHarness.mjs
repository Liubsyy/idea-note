import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const cache = new Map();
// Use the real translation modules in existing VM-based tests, with Chinese
// as the headless default. React hooks use the same React instance as the renderer.
export function i18nDependency(name) {
  const module = name.split('/').at(-1).replace(/\.ts$/, '');
  if (cache.has(module)) return cache.get(module);
  const exports = {};
  cache.set(module, exports);
  const source = readFileSync(new URL(`../src/i18n/${module}.ts`, import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require: (dependency) => dependency.startsWith('.') ? i18nDependency(dependency) : require(dependency),
  });
  return exports;
}
