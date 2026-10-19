// Keep the portable skill's references aligned with the in-app AI guide.
// Run with --check to verify without writing. Uses syntax parsing, never executes
// the app module or captures this machine's dynamic runner configuration.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = path.join(root, "src/lib/ai/componentGuide.ts");
const targetDir = path.join(root, "skills/idea-note/references");
const check = process.argv.includes("--check");
const source = ts.createSourceFile(
  sourcePath,
  await fs.readFile(sourcePath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const topics = ["overview", "input", "data", "output", "run", "examples"];
const sections = new Map();
for (const statement of source.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const topic = declaration.name.text.toLowerCase();
    if (!topics.includes(topic)) continue;
    if (!ts.isNoSubstitutionTemplateLiteral(declaration.initializer)) {
      throw new Error(`Expected a static guide section: ${topic}`);
    }
    sections.set(topic, declaration.initializer.text);
  }
}
// Resolve every section before any writes, so an unsupported source change
// cannot leave only part of the reference set updated.
const files = topics.map((topic) => {
  if (!sections.has(topic)) throw new Error(`Missing guide section: ${topic}`);
  return {
    name: `${topic}.md`,
    text: "<!-- Generated from src/lib/ai/componentGuide.ts. Update with node scripts/export-idea-note-skill.mjs. -->\n\n"
      + sections.get(topic).trim() + "\n",
  };
});
if (!check) await fs.mkdir(targetDir, { recursive: true });
let stale = false;
for (const file of files) {
  const target = path.join(targetDir, file.name);
  if (check) {
    const current = await fs.readFile(target, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (current !== file.text) {
      stale = true;
      console.error(`Out of date: ${path.relative(root, target)}`);
    }
  } else {
    await fs.writeFile(target, file.text);
  }
}
if (stale) process.exitCode = 1;
else console.log(`Idea Note skill references ${check ? "verified" : "exported"}: ${files.length} topics.`);
