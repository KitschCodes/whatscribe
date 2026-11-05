// Web Worker: runs Whisper locally with transformers.js (WebGPU if available, otherwise WASM).
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

let asr = null;
let loadedKey = null;

async function getPipeline(model) {
  const useGpu = !!(self.navigator && self.navigator.gpu && (await self.navigator.gpu.requestAdapter().catch(() => null)));
  const key = model + (useGpu ? ':gpu' : ':wasm');
  if (asr && loadedKey === key) return asr;
  if (asr && asr.dispose) await asr.dispose();
  asr = await pipeline('automatic-speech-recognition', model, {
    device: useGpu ? 'webgpu' : 'wasm',
    dtype: useGpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
      }
    },
  });
  loadedKey = key;
  self.postMessage({ type: 'device', device: useGpu ? 'WebGPU' : 'WASM' });
  return asr;
}

self.onmessage = async (e) => {
  const { audio, model, language, preload } = e.data;
  try {
    if (preload) {
      await getPipeline(model);
      self.postMessage({ type: 'ready' });
      return;
    }
    self.postMessage({ type: 'status', text: 'Carico il modello…' });
    const p = await getPipeline(model);
    self.postMessage({ type: 'status', text: 'Trascrivo…' });
    const out = await p(audio, {
      language,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    self.postMessage({ type: 'done', text: (out.text || '').trim() });
  } catch (err) {
    self.postMessage({ type: 'error', text: String(err && err.message || err) });
  }
};
