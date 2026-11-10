import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readVideoBlob } from '../reader.js';

const source = 'https://v26-web.douyinvod.com/signed/path/video/?__vid=7699099226327941887';
const mp4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52, 49]);
const localUrl = 'blob:https://www.douyin.com/test-reader';

function harness({ status = 200, headers = {}, chunks = [mp4], body = true,
  address = source, timeout = false, networkError = false } = {}) {
  const calls = [];
  const blobs = [];
  const revoked = [];
  const timers = new Map();
  let nextTimer = 0;
  let index = 0;
  let bodyCancelled = false;
  let readerCancelled = false;
  let released = false;
  class LocalURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return localUrl; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: body ? {
      async cancel() { bodyCancelled = true; },
      getReader() { return {
        async read() { return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; },
        async cancel() { readerCancelled = true; },
        releaseLock() { released = true; }
      }; }
    } : null,
    async arrayBuffer() { return mp4.buffer.slice(0); }
  };
  const context = {
    source: address, URL: LocalURL, AbortController, Blob, Uint8Array,
    setTimeout(fn, duration) {
      const id = ++nextTimer;
      timers.set(id, { fn, duration });
      if (timeout && duration === 120000) queueMicrotask(fn);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      calls.push({ url, options });
      if (networkError) throw Error('network failed');
      if (timeout) return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
      });
      return response;
    }
  };
  return {
    async run() { return structuredClone(await vm.runInNewContext(`(${readVideoBlob.toString()})(source)`, context)); },
    calls, blobs, revoked, timers,
    get bodyCancelled() { return bodyCancelled; },
    get readerCancelled() { return readerCancelled; },
    get released() { return released; }
  };
}

test('serialized reader fetches in the page context and returns a local MP4 Blob', async () => {
  const state = harness({ headers: { 'content-length': String(mp4.byteLength) }, chunks: [mp4.slice(0, 7), mp4.slice(7)] });
  const result = await state.run();
  assert.deepEqual(result, { ok: true, url: localUrl, size: mp4.byteLength, type: 'video/mp4' });
  assert.equal(state.calls[0].url, source);
  assert.equal(state.calls[0].options.credentials, 'omit');
  assert.ok(state.calls[0].options.signal instanceof AbortSignal);
  assert.equal(state.released, true);
  assert.equal(state.blobs.length, 1);
  assert.deepEqual(new Uint8Array(await state.blobs[0].arrayBuffer()), mp4);
  assert.deepEqual([...state.timers.values()].map(timer => timer.duration), [600000]);
  [...state.timers.values()][0].fn();
  assert.deepEqual(state.revoked, [localUrl]);
});

test('invalid sources never reach fetch and clear their abort timer', async () => {
  for (const address of ['https://evil.test/a.mp4', 'http://v26-web.douyinvod.com/a/',
    'https://user:pass@v26-web.douyinvod.com/a/', 'https://v26-web.douyinvod.com.evil.test/a/',
    'https://v26-web.douyinvod.com:8443/a/', 'https://www.douyin.com/login']) {
    const state = harness({ address });
    const result = await state.run();
    assert.equal(result.ok, false, address);
    assert.equal(state.calls.length, 0);
    assert.equal(state.timers.size, 0);
  }
});

test('HTTP failures are returned before any Blob is created', async () => {
  const state = harness({ status: 403 });
  const result = await state.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /403/);
  assert.equal(state.blobs.length, 0);
  assert.equal(state.timers.size, 0);
});

test('declared sizes above the limit cancel the body before reading', async () => {
  const state = harness({ headers: { 'content-length': String(512 * 1024 * 1024 + 1) } });
  const result = await state.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /512 MB/);
  assert.equal(state.bodyCancelled, true);
  assert.equal(state.released, false);
  assert.equal(state.blobs.length, 0);
});

test('unknown-length streams are also size bounded without buffering an oversized chunk', async () => {
  const state = harness({ chunks: [{ byteLength: 512 * 1024 * 1024 + 1 }] });
  const result = await state.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /512 MB/);
  assert.equal(state.readerCancelled, true);
  assert.equal(state.released, true);
  assert.equal(state.blobs.length, 0);
});

test('partial or malformed 206 responses are rejected and cancelled', async () => {
  for (const range of [undefined, 'bytes 1-23/24', 'bytes 0-11/24', 'bytes invalid']) {
    const state = harness({ status: 206, headers: range ? { 'content-range': range } : {} });
    const result = await state.run();
    assert.equal(result.ok, false, String(range));
    assert.match(result.error, /部分内容/);
    assert.equal(state.bodyCancelled, true);
    assert.equal(state.blobs.length, 0);
  }
});

test('a 206 response covering the complete file remains valid', async () => {
  const state = harness({ status: 206, headers: { 'content-range': 'bytes 0-23/24', 'content-length': '24' } });
  assert.equal((await state.run()).ok, true);
});

test('content-length and full-file range claims must equal the received bytes', async () => {
  for (const headers of [{ 'content-length': '25' }, { 'content-range': 'bytes 0-24/25' }]) {
    const state = harness({ headers });
    const result = await state.run();
    assert.equal(result.ok, false);
    assert.match(result.error, /不完整/);
    assert.equal(state.blobs.length, 0);
  }
});

test('HTML, empty and too-short responses never become downloadable MP4 Blobs', async () => {
  for (const chunk of [new TextEncoder().encode('<html>Forbidden</html>'), new Uint8Array(), mp4.slice(0, 11)]) {
    const state = harness({ chunks: [chunk] });
    const result = await state.run();
    assert.equal(result.ok, false);
    assert.match(result.error, /MP4/);
    assert.equal(state.blobs.length, 0);
    assert.equal(state.timers.size, 0);
  }
});

test('arrayBuffer fallback is supported when a response has no readable body', async () => {
  const state = harness({ body: false });
  assert.equal((await state.run()).ok, true);
});

test('timeout aborts fetch and returns a distinct message without leaking a timer', async () => {
  const state = harness({ timeout: true });
  const result = await state.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
  assert.equal(state.calls[0].options.signal.aborted, true);
  assert.equal(state.blobs.length, 0);
  assert.equal(state.timers.size, 0);
});

test('ordinary fetch failures return the keep-page-open recovery message', async () => {
  const state = harness({ networkError: true });
  const result = await state.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /保持视频页打开/);
  assert.equal(state.blobs.length, 0);
  assert.equal(state.timers.size, 0);
});
