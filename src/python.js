import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);

export async function pythonEnvironment(workspace,base,uv='uv') {
  const venv=path.join(workspace,'state','python');
  const env={...process.env,UV_CACHE_DIR:path.join(workspace,'state','uv-cache'),UV_PYTHON_INSTALL_DIR:path.join(workspace,'state','uv-python'),UV_TOOL_DIR:path.join(workspace,'state','uv-tools'),UV_TOOL_BIN_DIR:path.join(workspace,'state','home','.local','bin'),UV_LINK_MODE:'copy'};
  await fs.mkdir(path.dirname(venv),{recursive:true});
  try {await fs.access(path.join(venv,'bin','python'));}
  catch(e) {
    if(e.code!=='ENOENT') throw e;
    await exec(uv,['venv','--python',base,'--system-site-packages',venv],{env,timeout:60000});
  }
  // Validate the persisted interpreter rather than silently replacing user packages.
  await exec(path.join(venv,'bin','python'),['-c','import sys; assert sys.prefix != sys.base_prefix'],{env,timeout:10000});
  return {PATH:`${path.join(venv,'bin')}:${env.UV_TOOL_BIN_DIR}:${process.env.PATH}`,VIRTUAL_ENV:venv,UV_CACHE_DIR:env.UV_CACHE_DIR,UV_PYTHON_INSTALL_DIR:env.UV_PYTHON_INSTALL_DIR,UV_TOOL_DIR:env.UV_TOOL_DIR,UV_TOOL_BIN_DIR:env.UV_TOOL_BIN_DIR,UV_LINK_MODE:'copy'};
}
