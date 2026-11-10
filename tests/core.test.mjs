import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isMediaUrl, isDouyinPage, makeFilename, formatDuration, downloadError } from '../lib.js';

test('accepts only HTTPS Douyin pages and expected CDN/play endpoints', () => {
  assert.equal(isDouyinPage('https://www.douyin.com/video/7699099226327941887'), true);
  for (const url of ['https://douyin.com.attacker.test/', 'file:///tmp/a', 'https://example.com/']) {
    assert.equal(isDouyinPage(url), false);
  }
  assert.equal(isMediaUrl('https://v26-web.douyinvod.com/a/?__vid=7699099226327941887'), true);
  assert.equal(isMediaUrl('https://www.douyin.com/aweme/v1/play/?video_id=123'), true);
  for (const url of ['https://douyinvod.com.evil.test/video', 'https://evil.test/video.mp4',
    'http://v26-web.douyinvod.com/video', 'https://user:pass@v26-web.douyinvod.com/a',
    'https://v26-web.douyinvod.com:444/a', 'https://www.douyin.com/login',
    'blob:https://www.douyin.com/123', 'javascript:alert(1)', 'https://127.0.0.1/a']) {
    assert.equal(isMediaUrl(url), false, url);
  }
});

test('filename cannot traverse folders and remains usable across operating systems', () => {
  const name = makeFilename('../../a/b\\c : ?* \u0000 你好 😺', '7699099226327941887');
  assert.equal(/[<>:"/\\|?*\u0000]/.test(name), false);
  assert.equal(name.startsWith('.'), false);
  assert.ok(name.endsWith('_7699099226327941887.mp4'));
  assert.ok(name.includes('你好 😺'));
  assert.equal(makeFilename('CON', 'bad/id'), '视频_CON.mp4');
  assert.equal(makeFilename('...', ''), '抖音视频.mp4');
  assert.ok(Array.from(makeFilename('😺'.repeat(100), '')).length < 80);
});

test('duration and cancellation/error messages distinguish useful states', () => {
  assert.equal(formatDuration(19.0667), '0:19');
  assert.equal(formatDuration(Infinity), '时长待识别');
  assert.match(downloadError('USER_CANCELED'), /取消/);
  assert.match(downloadError('SERVER_FORBIDDEN'), /重新识别/);
  assert.match(downloadError('NETWORK_FAILED'), /网络/);
});

let listener;
let downloadChanged;
let options;
let downloadCalls = [];
let scriptCalls = [];
let failStage = '';
let failDownload = false;
let scriptResult;
let localResult;
const currentId = '7699099226327941887';
const shownVideo = {
  url: `https://v26-web.douyinvod.com/old-signed-path/?__vid=${currentId}&token=old`,
  title: '面板中原来的标题', videoId: currentId
};
const freshVideo = {
  url: `https://v26-web.douyinvod.com/fresh-signed-path/?__vid=${currentId}&token=new`,
  title: '好伙伴一起APT', videoId: currentId, width: 960, height: 540, duration: 19.0667
};
const blobUrl = 'blob:https://www.douyin.com/3be6b0e0-7cd4-45c0-bd52-636769c3e0f4';
globalThis.chrome = {
  runtime: { id: 'test-extension', onMessage: { addListener(fn) { listener = fn; } } },
  scripting: { async executeScript(value) {
    scriptCalls.push(value);
    if (value.func.name === failStage) throw Error('Tab no longer available');
    if (value.func.name === 'inspectPage') return [{ result: scriptResult }];
    if (value.func.name === 'readVideoBlob') return [{ result: localResult }];
    // Completion cleanup is injected as a small anonymous function.
    assert.equal(value.args[0], blobUrl);
    return [{ result: undefined }];
  } },
  downloads: {
    onChanged: { addListener(fn) { downloadChanged = fn; } },
    async download(value) {
      options = value;
      downloadCalls.push(value);
      if (failDownload) throw Error('User cancelled Save As');
      return 27;
    }
  }
};
await import('../background.js');

test.beforeEach(() => {
  options = undefined;
  downloadCalls = [];
  scriptCalls = [];
  failStage = '';
  failDownload = false;
  scriptResult = { pageUrl: `https://www.douyin.com/video/${currentId}`, video: structuredClone(freshVideo) };
  localResult = { ok: true, url: blobUrl, size: 1523998, type: 'video/mp4' };
});

test.afterEach(() => {
  // This is the regression that caused the user's HTTP 403: native downloads
  // must never repeat either the stale or fresh remote CDN request.
  for (const call of downloadCalls) {
    assert.equal(call.url, blobUrl);
    assert.notEqual(call.url, freshVideo.url);
    assert.notEqual(call.url, shownVideo.url);
  }
  if (options && !failDownload) downloadChanged({ id: 27, state: { current: 'complete' } });
});

const startDownload = (overrides = {}) => new Promise(resolve => {
  const keepAlive = listener({ type: 'DOWNLOAD_VIDEO', tabId: 42,
    video: structuredClone(shownVideo), ...overrides }, { id: 'test-extension' }, resolve);
  assert.equal(keepAlive, true);
});

test('service worker rejects untrusted sender and invalid sources', () => {
  let reply;
  listener({ type: 'DOWNLOAD_VIDEO', tabId: 42, video: { url: 'https://evil.test/a.mp4' } }, { id: 'test-extension' }, r => reply = r);
  assert.equal(reply.ok, false);
  assert.equal(options, undefined);
  assert.deepEqual(scriptCalls, []);
  reply = undefined;
  listener({ type: 'DOWNLOAD_VIDEO', tabId: 42, video: shownVideo }, { id: 'other' }, r => reply = r);
  assert.equal(reply, undefined);
  assert.deepEqual(scriptCalls, []);
});

test('service worker rejects a missing or invalid source tab before inspecting', () => {
  for (const tabId of [undefined, '42', null, 1.5]) {
    let reply;
    listener({ type: 'DOWNLOAD_VIDEO', tabId, video: shownVideo }, { id: 'test-extension' }, r => reply = r);
    assert.equal(reply.ok, false);
    assert.deepEqual(scriptCalls, []);
    assert.equal(options, undefined);
  }
});

test('worker reads the fresh source through the page and saves only its local Blob', async () => {
  const reply = await startDownload();
  assert.deepEqual(reply, { ok: true, id: 27, video: freshVideo });
  assert.equal(scriptCalls.length, 2);
  assert.deepEqual(scriptCalls[0].target, { tabId: 42 });
  assert.equal(scriptCalls[0].world, 'ISOLATED');
  assert.equal(scriptCalls[0].func.name, 'inspectPage');
  assert.deepEqual(scriptCalls[1].target, { tabId: 42 });
  assert.equal(scriptCalls[1].world, 'ISOLATED');
  assert.equal(scriptCalls[1].func.name, 'readVideoBlob');
  assert.deepEqual(scriptCalls[1].args, [freshVideo.url]);
  assert.notEqual(scriptCalls[1].args[0], shownVideo.url);
  assert.deepEqual(options, {
    url: blobUrl,
    filename: '好伙伴一起APT_7699099226327941887.mp4',
    conflictAction: 'uniquify',
    saveAs: true
  });
});

test('switching the page to another video does not silently download it', async () => {
  scriptResult.video.videoId = '7704961445700202491';
  const reply = await startDownload();
  assert.equal(reply.ok, false);
  assert.match(reply.error, /另一个视频/);
  assert.equal(options, undefined);
  assert.equal(scriptCalls.length, 1);
});

test('missing or untrusted fresh sources cannot reuse the old cached source', async () => {
  for (const video of [null, { ...freshVideo, url: 'https://evil.test/a.mp4' }]) {
    scriptResult = { pageUrl: `https://www.douyin.com/video/${currentId}`, video };
    const reply = await startDownload();
    assert.equal(reply.ok, false);
    assert.match(reply.error, /重新识别/);
    assert.equal(options, undefined);
    assert.equal(scriptCalls.every(call => call.func.name === 'inspectPage'), true);
  }
});

test('a non-Douyin page cannot supply a local download even with a CDN URL', async () => {
  scriptResult.pageUrl = 'https://evil.test/';
  const reply = await startDownload();
  assert.equal(reply.ok, false);
  assert.equal(options, undefined);
  assert.equal(scriptCalls.length, 1);
});

test('closed or inaccessible source tabs return an actionable failure', async () => {
  failStage = 'inspectPage';
  const reply = await startDownload();
  assert.equal(reply.ok, false);
  assert.match(reply.error, /保持视频页打开/);
  assert.equal(options, undefined);
  assert.equal(scriptCalls.length, 1);
});

test('reader failures are reported without falling back to a remote native download', async () => {
  localResult = { ok: false, error: '读取视频超时，请检查网络后再试。' };
  const reply = await startDownload();
  assert.equal(reply.ok, false);
  assert.equal(reply.error, localResult.error);
  assert.equal(options, undefined);
});

test('unsafe Blob origins, remote URLs, wrong types and invalid sizes are rejected', async () => {
  const invalid = [
    { url: freshVideo.url }, { url: 'blob:https://evil.test/uuid' },
    { url: 'blob:https://www.douyin.com.evil.test/uuid' }, { url: 'blob:null/uuid' },
    { size: 0 }, { size: 11 }, { size: Infinity }, { size: 512 * 1024 * 1024 + 1 },
    { type: 'text/html' }
  ];
  for (const fields of invalid) {
    localResult = { ok: true, url: blobUrl, size: 1523998, type: 'video/mp4', ...fields };
    const reply = await startDownload();
    assert.equal(reply.ok, false, JSON.stringify(fields));
    assert.match(reply.error, /文件无效/);
    assert.equal(options, undefined);
  }
});

test('cancelled native Save As is handled without an unhandled rejection', async () => {
  failDownload = true;
  const reply = await startDownload();
  assert.equal(reply.ok, false);
  assert.match(reply.error, /取消/);
  assert.equal(options.url, blobUrl);
});

test('completion revokes the page Blob once, while progress and unrelated downloads do not', async () => {
  await startDownload();
  downloadChanged({ id: 27, state: { current: 'in_progress' } });
  downloadChanged({ id: 999, state: { current: 'complete' } });
  assert.equal(scriptCalls.length, 2);
  downloadChanged({ id: 27, state: { current: 'complete' } });
  assert.equal(scriptCalls.length, 3);
  assert.deepEqual(scriptCalls[2].target, { tabId: 42 });
  assert.equal(scriptCalls[2].world, 'ISOLATED');
  assert.deepEqual(scriptCalls[2].args, [blobUrl]);
  downloadChanged({ id: 27, state: { current: 'complete' } });
  assert.equal(scriptCalls.length, 3);
});

test('interrupted downloads also revoke their page Blob', async () => {
  await startDownload();
  downloadChanged({ id: 27, state: { current: 'interrupted' } });
  assert.equal(scriptCalls.length, 3);
  assert.deepEqual(scriptCalls[2].args, [blobUrl]);
});

test('obsolete prepare messages cannot launch the previous remote-download path', () => {
  let reply;
  const keepAlive = listener({ type: 'PREPARE_DOWNLOAD', tabId: 42, video: shownVideo },
    { id: 'test-extension' }, value => reply = value);
  assert.equal(keepAlive, undefined);
  assert.equal(reply, undefined);
  assert.deepEqual(scriptCalls, []);
  assert.equal(options, undefined);
});

test('manifest is loadable without DNR or persistent host permissions', async () => {
  const base = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'downloads', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
  const files = [manifest.action.default_popup, manifest.background.service_worker, ...Object.values(manifest.icons)];
  for (const file of files) assert.ok((await readFile(new URL(file, base))).length);
});
