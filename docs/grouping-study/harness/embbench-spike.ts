// Phase B on-device benchmark harness (m0.8 grouping study). To reuse: copy to
// apps/mobile/src/lib/spike.ts and add the TEMP useEffect hook in App.tsx (see
// this file's header comment); release-build, install, capture [EMBBENCH] via logcat.
/**
 * TEMPORARY — m0.8 grouping study Phase B benchmark. DELETE AFTER USE.
 *
 * Measures the on-device embedder (modules/image-embedder, MediaPipe
 * MobileNetV3-large) against the Phase C bar (docs/Grouping_study_m0.8.md):
 * end-to-end ms/photo over the newest N photos, decode/infer breakdown,
 * plus pairwise cosines of the first VERIFY_N embeddings for equivalence
 * checks against the desktop pipeline. Logcat tags: [EMBBENCH] / [VERIFY].
 */
import * as MediaLibrary from 'expo-media-library/legacy';
import { Platform } from 'react-native';
import { pagePhotosInRange, type LoadedPhoto } from './media';
import { embed, decodeVec } from '../../modules/image-embedder';

const BENCH_N = 300;
const VERIFY_N = 10;

const startedAt = Date.now();
const log = (message: string): void => {
  console.log(`[EMBBENCH] +${((Date.now() - startedAt) / 1000).toFixed(1)}s ${message}`);
};

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

let ran = false;

export async function runSpike(): Promise<void> {
  if (ran) return;
  ran = true;
  const model = (Platform.constants as { Model?: string }).Model ?? 'unknown';
  log(`device: ${model} api ${Platform.Version}`);

  const permission = await MediaLibrary.requestPermissionsAsync();
  if (!permission.granted) {
    log('ABORT: no media permission');
    return;
  }

  const photos: LoadedPhoto[] = [];
  await pagePhotosInRange(
    0,
    Date.now() + 24 * 3600 * 1000,
    undefined,
    (page) => {
      photos.push(...page);
      return photos.length < BENCH_N;
    },
    true,
  );
  const sample = photos.slice(0, BENCH_N);
  log(`sample: ${sample.length} photos`);

  const total: number[] = [];
  const decodes: number[] = [];
  const infers: number[] = [];
  const vecs: { name: string; vec: Float32Array }[] = [];
  let failures = 0;
  const wallStart = Date.now();
  for (let i = 0; i < sample.length; i++) {
    const t0 = Date.now();
    try {
      const result = await embed(sample[i].item.uri);
      if (result === null) {
        log('ABORT: native module missing');
        return;
      }
      total.push(Date.now() - t0);
      decodes.push(result.decodeMs);
      infers.push(result.inferMs);
      if (vecs.length < VERIFY_N) {
        vecs.push({ name: sample[i].filename, vec: decodeVec(result.vecB64) });
      }
    } catch (error) {
      failures++;
      if (failures <= 3) log(`fail ${sample[i].filename}: ${String(error)}`);
    }
    if ((i + 1) % 50 === 0) {
      const rate = (i + 1) / ((Date.now() - wallStart) / 1000);
      log(`progress ${i + 1}/${sample.length} (${rate.toFixed(1)}/s)`);
    }
  }
  const wallMs = Date.now() - wallStart;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  total.sort((a, b) => a - b);
  log(
    `RESULT n=${total.length} failures=${failures} wall=${(wallMs / 1000).toFixed(1)}s ` +
      `→ ${(total.length / (wallMs / 1000)).toFixed(1)} photos/s | ` +
      `end-to-end mean ${Math.round(sum(total) / total.length)} p50 ${percentile(total, 50)} ` +
      `p90 ${percentile(total, 90)} max ${total[total.length - 1]}ms | ` +
      `decode mean ${Math.round(sum(decodes) / decodes.length)}ms, ` +
      `infer mean ${Math.round(sum(infers) / infers.length)}ms`,
  );

  for (let a = 0; a < vecs.length; a++) {
    for (let b = a + 1; b < vecs.length; b++) {
      let dot = 0;
      for (let k = 0; k < vecs[a].vec.length; k++) dot += vecs[a].vec[k] * vecs[b].vec[k];
      console.log(`[VERIFY] ${vecs[a].name}|${vecs[b].name}|${dot.toFixed(4)}`);
    }
  }
  log('DONE');
}
