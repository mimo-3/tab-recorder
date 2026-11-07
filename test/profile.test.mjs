import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveProfile} from '../lib/profile.mjs';

const EXTENSION = 'bjidelnfdjcggjdogogicbahlcgigodk';
const INSTANCE = 'abcdef01-2345-4678-9abc-def012345678';

async function support(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tabrec-prof-support-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

async function profile(root, browser, name, {files = {}, preferences} = {}) {
  const dir = join(root, browser, name);
  const storage = join(dir, 'Local Extension Settings', EXTENSION);
  await mkdir(storage, {recursive: true});
  for (const [file, content] of Object.entries(files)) await writeFile(join(storage, file), content);
  if (preferences !== undefined) await writeFile(join(dir, 'Preferences'), preferences);
}

test('profile is found by the instance ID in extension LevelDB files', async t => {
  const root = await support(t);
  await profile(root, 'Aside', 'Default', {files: {'000003.log': 'instanceId"other"'}, preferences: '{"profile":{"name":"Home"}}'});
  await profile(root, 'Google/Chrome', 'Profile 3', {
    files: {'LOG': INSTANCE, '000005.ldb': `\0\x01instanceId"${INSTANCE}"`},
    preferences: JSON.stringify({profile: {name: '仕事'}}),
  });
  assert.deepEqual(await resolveProfile(INSTANCE, {supportDir: root, extensionId: EXTENSION}),
    {browser: 'chrome', profileDir: 'Profile 3', profileName: '仕事'});
});

test('unflushed storage, missing browsers and broken Preferences are tolerated', async t => {
  const root = await support(t);
  assert.equal(await resolveProfile(INSTANCE, {supportDir: root, extensionId: EXTENSION}), null);
  await profile(root, 'Aside', 'Default', {files: {'MANIFEST-000001': INSTANCE}});
  assert.equal(await resolveProfile(INSTANCE, {supportDir: root, extensionId: EXTENSION}), null);
  await profile(root, 'Aside', 'Profile 1', {files: {'000007.log': INSTANCE}, preferences: '{broken'});
  assert.deepEqual(await resolveProfile(INSTANCE, {supportDir: root, extensionId: EXTENSION}),
    {browser: 'aside', profileDir: 'Profile 1', profileName: null});
});
