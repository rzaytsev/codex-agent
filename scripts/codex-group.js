#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// SDK supports a binary override, but not exec's config/rule isolation flags.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args[0]!=='exec')process.exit(2);
args.splice(1,0,'--ignore-user-config','--ignore-rules','--strict-config');
const child=spawn(process.execPath,[path.join(root,'node_modules/@openai/codex/bin/codex.js'),...args],{stdio:'inherit',env:process.env});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>process.exit(1));
child.on('exit',code=>process.exit(code??1));
