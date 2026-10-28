#!/usr/bin/env node
// Codex runs commands through `bash -lc`. Distribution profiles such as Debian's
// replace PATH, which drops Codex's apply_patch alias and image tool directories.
// Keep their defaults only for shells that start without a PATH.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const profile = process.argv[2] ?? '/etc/profile';
if (existsSync(profile)) {
  const source = readFileSync(profile, 'utf8');
  const updated = source.replace(/^([ \t]*)(export[ \t]+)?PATH=("?)([^"$\s]+)\3[ \t]*$/gm,
    (_line, indent, exported = '', quote, value) => `${indent}${exported}PATH=${quote}\${PATH:-${value}}${quote}`);
  if (updated !== source) writeFileSync(profile, updated);
}
