import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { executorEnvironment, isReadOnlyMount, prepareResearchAuth, usesIsolatedResearch } from '../src/isolated-research.js';

test('executor opt-in and mount requirements fail closed', () => {
  assert.equal(config({}).isolatedResearchExecutor, false);
  assert.equal(config({ISOLATED_RESEARCH_EXECUTOR:'true'}).isolatedResearchExecutor, true);
  const entry='12 1 8:1 /root /run/control/config.toml ro,relatime - ext4 /dev/root rw\n';
  assert.equal(isReadOnlyMount(entry, '/run/control/config.toml'), true);
  assert.equal(isReadOnlyMount(entry.replace(' ro,',' rw,'), '/run/control/config.toml'), false);
  assert.equal(isReadOnlyMount(entry+entry, '/run/control/config.toml'), false);
  assert.equal(isReadOnlyMount(entry, '/run/control'), false);
  assert.match(executorEnvironment('/node','/connector','/socket'), /include_local=false/);
});

test('research auth follows atomic login rotation and rejects a copied or substituted file', async t => {
  const root=await fs.mkdtemp('/tmp/isolated-research-auth-test-');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'active-auth.json'), next=path.join(root,'replacement.json');
  const link=path.join(root,'research-auth.json');
  await fs.writeFile(source,'synthetic old login');
  await prepareResearchAuth(link,source);
  assert.equal(await fs.readFile(link,'utf8'),'synthetic old login');
  await fs.writeFile(next,'synthetic rotated login');
  await fs.rename(next,source);
  await prepareResearchAuth(link,source);
  assert.equal(await fs.readFile(link,'utf8'),'synthetic rotated login');
  await fs.unlink(link);
  await fs.writeFile(link,'synthetic stale login');
  await assert.rejects(prepareResearchAuth(link,source));
});

test('internal review isolation is opt-in and limited to the existing read-only reviewers', () => {
  const regular=config({ISOLATED_RESEARCH_EXECUTOR:'true'});
  const both=config({ISOLATED_RESEARCH_EXECUTOR:'true',ISOLATED_INTERNAL_REVIEWS:'true'});
  assert.equal(usesIsolatedResearch(regular,'research',false),true);
  assert.equal(usesIsolatedResearch(regular,'research','learning'),false);
  for(const mode of [true,'learning','learning-validation','research-validation']) {
    assert.equal(usesIsolatedResearch(both,'research',mode),true);
    assert.equal(usesIsolatedResearch(both,'review',mode),true);
  }
  for(const profile of ['main','worker','deep_research']) {
    assert.equal(usesIsolatedResearch(both,profile,false),false);
    assert.equal(usesIsolatedResearch(both,profile,'learning'),false);
  }
  assert.equal(usesIsolatedResearch(both,'review',false),false);
  assert.equal(usesIsolatedResearch(both,'review','future-mode'),false);
});

test('deep collection has its own opt-in and does not authorize internal reviewer roles', () => {
  const deep=config({ISOLATED_DEEP_RESEARCH:'true'});
  assert.equal(usesIsolatedResearch(deep,'deep_research',false),true);
  assert.equal(usesIsolatedResearch(deep,'deep_research','research-validation'),false);
  for(const profile of ['main','worker','research','review']) {
    assert.equal(usesIsolatedResearch(deep,profile,false),false);
    assert.equal(usesIsolatedResearch(deep,profile,'research-validation'),false);
  }
});
