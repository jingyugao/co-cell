import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const projectRoot = resolve(import.meta.dirname, '..');
const privateRoot = resolve(projectRoot, 'packages/archives/src');
const scanRoots = ['backend', 'fe', 'protocol', 'util', 'scripts', 'packages'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs']);
const ignoredDirectories = new Set(['node_modules', 'dist', 'tmp', '.git']);
const violations = [];

function inside(path, root) { return path === root || path.startsWith(`${root}${sep}`); }

function checkSpecifier(file, line, specifier) {
  if (specifier === '@co-cell/archives') return;
  if (specifier.startsWith('@co-cell/archives/')) {
    violations.push(`${relative(projectRoot, file)}:${line}: import the public @co-cell/archives entry point`);
    return;
  }
  if (!specifier.startsWith('.')) return;
  const destination = resolve(dirname(file), specifier);
  if (inside(destination, privateRoot) && !inside(file, privateRoot)) {
    violations.push(`${relative(projectRoot, file)}:${line}: archive implementation is private; import @co-cell/archives`);
  }
}

async function scan(file) {
  const source = await readFile(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  function visit(node) {
    let literal;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal;
    else if (ts.isCallExpression(node) && node.arguments.length === 1
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      literal = node.arguments[0];
    }
    if (literal && ts.isStringLiteralLike(literal)) {
      const line = ast.getLineAndCharacterOfPosition(literal.getStart(ast)).line + 1;
      checkSpecifier(file, line, literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await walk(child);
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) await scan(child);
  }
}

for (const root of scanRoots) await walk(resolve(projectRoot, root));
if (violations.length) {
  process.stderr.write(`${violations.join('\n')}\n`);
  process.exitCode = 1;
} else process.stdout.write('Archive package boundary is intact.\n');
