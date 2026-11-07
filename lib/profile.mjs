import * as defaultFs from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, join} from 'node:path';
import {extensionId as defaultExtensionId} from './extension-id.mjs';

export const browserDirs = {aside: 'Aside', chrome: 'Google/Chrome'};
const STORAGE_FILE = /\.(log|ldb)$/;
const STORAGE_FILE_LIMIT = 8 * 1024 * 1024;

async function entries(fs, dir) {
  try {
    return await fs.readdir(dir, {withFileTypes: true});
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return [];
    throw error;
  }
}

async function storageContains(fs, dir, needle) {
  for (const entry of await entries(fs, dir)) {
    if (!entry.isFile() || !STORAGE_FILE.test(entry.name)) continue;
    const path = join(dir, entry.name);
    try {
      if ((await fs.stat(path)).size > STORAGE_FILE_LIMIT) continue;
      if ((await fs.readFile(path)).includes(needle)) return true;
    } catch (error) {
      // LevelDB compaction can remove files while we scan.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function readJson(fs, path) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// The UI name lives in the browser-level Local State; the per-profile
// Preferences copy can be stale, so it is only a fallback.
async function profileName(fs, browserDir, profileDir) {
  const fromState = (await readJson(fs, join(browserDir, 'Local State')))?.profile?.info_cache?.[basename(profileDir)]?.name;
  if (typeof fromState === 'string') return fromState;
  const fromPrefs = (await readJson(fs, join(profileDir, 'Preferences')))?.profile?.name;
  return typeof fromPrefs === 'string' ? fromPrefs : null;
}

// Finds the browser profile whose extension storage holds this instance ID.
// LevelDB may not have flushed the ID yet, so callers retry on null.
export async function resolveProfile(instanceId, {
  fs = defaultFs,
  supportDir = join(homedir(), 'Library/Application Support'),
  extensionId = defaultExtensionId,
} = {}) {
  const needle = Buffer.from(instanceId);
  for (const [browser, relative] of Object.entries(browserDirs)) {
    const browserDir = join(supportDir, relative);
    for (const entry of await entries(fs, browserDir)) {
      if (!entry.isDirectory()) continue;
      const dir = join(browserDir, entry.name);
      if (await storageContains(fs, join(dir, 'Local Extension Settings', extensionId), needle)) {
        return {browser, profileDir: entry.name, profileName: await profileName(fs, browserDir, dir)};
      }
    }
  }
  return null;
}
