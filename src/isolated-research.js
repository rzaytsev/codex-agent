import fs from 'node:fs/promises';
import path from 'node:path';

const home = '/run/codex-research';
const authDirectory = '/run/codex-research-auth';
const socketDirectory = '/run/codex-agent-executor';
const configText = '# Operator-owned isolated research config\n';

export const isolatedResearchDefinition = Object.freeze({
  version: 1, mode: 'remote_only_research', execution: 'offline_executor',
  bridge: 'loopback_http', thread: 'fresh',
});

export function usesIsolatedResearch(cfg, profile, review) {
  if (!review) return profile === 'research' && cfg.isolatedResearchExecutor === true;
  return cfg.isolatedInternalReviews === true && ['research', 'review'].includes(profile) &&
    [true, 'learning', 'learning-validation', 'research-validation'].includes(review);
}

export function executorEnvironment(node, connector, socket) {
  return [
    'default="isolated-worker"', 'include_local=false', '[[environments]]', 'id="isolated-worker"',
    `program=${JSON.stringify(node)}`, `args=${JSON.stringify([connector, socket])}`, '',
  ].join('\n');
}

export function isReadOnlyMount(mountinfo, mountpoint) {
  const entries = mountinfo.split('\n').map(row => row.split(' ')).filter(row => row[4] === mountpoint);
  return entries.length === 1 && entries[0][5]?.split(',').includes('ro');
}

// Link to the directory mount rather than a mounted auth inode. An atomic
// replacement by the existing login flow becomes visible to the next turn.
export async function prepareResearchAuth(authLink, source) {
  const auth = await fs.lstat(source);
  if (!auth.isFile()) throw new Error('Isolated research login unavailable');
  try { await fs.symlink(source, authLink); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (await fs.readlink(authLink) !== source) throw new Error('Isolated research login unavailable');
}

export async function isolationOptions(token) {
  try {
    const mountinfo = await fs.readFile('/proc/self/mountinfo', 'utf8');
    const envFile = path.join(home, 'environments.toml');
    const configFile = path.join(home, 'config.toml');
    const socket = path.join(socketDirectory, 'stdio.sock');
    const connector = path.resolve('scripts/isolated-executor-stdio.js');
    if (![envFile, configFile, authDirectory, socketDirectory].every(name => isReadOnlyMount(mountinfo, name))) throw Error();
    if (await fs.readFile(envFile, 'utf8') !== executorEnvironment(process.execPath, connector, socket)) throw Error();
    if (await fs.readFile(configFile, 'utf8') !== configText) throw Error();
    const endpoint = await fs.lstat(socket);
    if (!endpoint.isSocket() || endpoint.uid !== 0 || (endpoint.mode & 0o777) !== 0o600) throw Error();
    await prepareResearchAuth(path.join(home, 'auth.json'), path.join(authDirectory, 'auth.json'));
    const url = 'http://127.0.0.1:8765/mcp';
    const http_headers = {Authorization: `Bearer ${token}`};
    return {
      home, assistant: {url, http_headers, startup_timeout_sec:30, required:true},
      override: `mcp_servers.assistant={url=${JSON.stringify(url)},http_headers={Authorization=${JSON.stringify(http_headers.Authorization)}},startup_timeout_sec=30,required=true}`,
      shellPolicy: 'shell_environment_policy={inherit="none",ignore_default_excludes=true,exclude=[],include_only=["PATH","LANG"],experimental_use_profile=false,set={PATH="/usr/bin:/bin",LANG="C.UTF-8"}}',
    };
  } catch {
    throw new Error('Isolated research executor configuration unavailable');
  }
}
