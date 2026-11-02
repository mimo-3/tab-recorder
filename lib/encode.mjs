import * as defaultFs from 'node:fs/promises';
import {spawn as defaultSpawn} from 'node:child_process';
import {join} from 'node:path';
import {concatList} from './core.mjs';

const STDERR_LIMIT = 4000;
const VIDEO_FILTER = 'scale=ceil(iw/2)*2:ceil(ih/2)*2:out_range=tv,format=yuv420p,setparams=range=limited';

export function runFfmpeg(ffmpeg, concat, output, spawn = defaultSpawn) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, [
        '-n', '-f', 'concat', '-safe', '0', '-i', concat,
        '-vf', VIDEO_FILTER, '-fps_mode', 'vfr', '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
      ], {stdio: ['ignore', 'ignore', 'pipe']});
    } catch (error) {
      error.ffmpegFailure = true;
      reject(error);
      return;
    }
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.once('error', error => {
      error.ffmpegFailure = true;
      reject(error);
    });
    child.once('close', code => {
      if (code === 0) resolve();
      else {
        const error = new Error(`ffmpeg failed: ${stderr || `exit ${code}`}`);
        error.ffmpegFailure = true;
        reject(error);
      }
    });
  });
}

export async function encodeRecording(dir, {
  output = join(dir, 'capture.mp4'),
  ffmpeg = process.env.TAB_RECORDER_FFMPEG || 'ffmpeg',
  spawn = defaultSpawn,
  fs = defaultFs,
  stoppedAt,
} = {}) {
  const metadata = await fs.readFile(join(dir, 'frames.jsonl'), 'utf8');
  const frames = metadata.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const content = concatList(frames, dir, stoppedAt);
  const concat = join(dir, 'frames.concat');
  await fs.unlink(concat).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  await fs.writeFile(concat, content, {flag: 'wx'});
  await runFfmpeg(ffmpeg, concat, output, spawn);
  return output;
}
