import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extractor.js', import.meta.url), 'utf8');
const { inspectPage } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const target = '7699099226327941887';
const other = '7704961445700202491';
const cdn = (id = target, extra = '') => `https://v26-web.douyinvod.com/signed/video/?a=6383&__vid=${id}${extra}`;

function video(options = {}) {
  const rect = options.rect || { left: 100, top: 100, right: 1060, bottom: 640 };
  return {
    currentSrc: cdn(), src: '', videoWidth: 960, videoHeight: 540,
    duration: 19.066667, poster: '', paused: false, ended: false,
    ...options,
    getBoundingClientRect: () => rect,
    querySelectorAll: () => (options.sources || []).map((src) => ({ src })),
  };
}

function run({ href = `https://www.douyin.com/video/${target}`, title = '好伙伴一起APT. - 抖音',
  videos = [], render = '', scripts = [], resources = [] } = {}) {
  const context = {
    URL, location: new URL(href),
    window: { innerWidth: 1280, innerHeight: 720 },
    document: {
      title,
      documentElement: { clientWidth: 1280, clientHeight: 720 },
      querySelectorAll: (selector) => selector === 'video' ? videos :
        selector === 'script:not([src])' ? scripts.map((textContent) => ({ textContent })) : [],
      getElementById: (id) => id === 'RENDER_DATA' && render ? { textContent: render } : null,
    },
    getComputedStyle: (element) => element.style || { display: 'block', visibility: 'visible', opacity: '1' },
    performance: { getEntriesByType: () => resources.map((name) => ({ name })) },
  };
  // The same serialization boundary as chrome.scripting.executeScript(func).
  const result = vm.runInNewContext(`(${inspectPage.toString()})()`, context);
  return JSON.parse(JSON.stringify(result));
}

test('current visible playback wins over an offscreen preloaded video', () => {
  const result = run({ videos: [
    video({ currentSrc: cdn(other), rect: { left: 100, right: 1060, top: 850, bottom: 1390 } }),
    video({ currentSrc: cdn(target, '&sig=a%2Fb%3D') }),
  ] });
  assert.equal(result.video.url, cdn(target, '&sig=a%2Fb%3D'));
  assert.equal(result.video.source, 'currentSrc');
  assert.equal(result.video.title, '好伙伴一起APT.');
  assert.equal(result.video.width, 960);
  assert.equal(result.video.duration, 19.066667);
  assert.equal(result.video.poster, '');
  assert.equal(result.videoId, target);
});

test('playing video wins over a visible paused preview', () => {
  const result = run({ href: 'https://www.douyin.com/', videos: [
    video({ currentSrc: cdn(other), paused: true }), video(),
  ] });
  assert.equal(result.video.url, cdn());
});

test('blob playback falls back to an existing source element', () => {
  const result = run({ videos: [video({ currentSrc: 'blob:https://www.douyin.com/abc', sources: [cdn()] })] });
  assert.equal(result.video.url, cdn());
  assert.equal(result.video.source, 'source');
});

test('video src is usable before currentSrc initializes', () => {
  const result = run({ videos: [video({ currentSrc: '', src: cdn() })] });
  assert.equal(result.video.url, cdn());
});

test('rejects stale target and untagged sources associated with it', () => {
  const result = run({ videos: [video({ currentSrc: cdn(other), sources: ['https://v26-web.douyinvod.com/untagged/'] })] });
  assert.equal(result.video, null);
  assert.match(result.reason, /播放/);
});

test('a source explicitly matching the target may replace stale playback', () => {
  const result = run({ videos: [video({ currentSrc: cdn(other), sources: [cdn()] })] });
  assert.equal(result.video.url, cdn());
});

test('hidden videos with unknown or different identities are not selected', () => {
  for (const currentSrc of ['https://v26-web.douyinvod.com/untagged/', cdn(other)]) {
    const result = run({ videos: [video({ currentSrc, style: { display: 'none' } })] });
    assert.equal(result.video, null);
  }
});

test('an exact-ID currentSrc is usable when Douyin hides its canvas-backed video', () => {
  const result = run({ videos: [video({
    style: { display: 'none' }, videoWidth: 0, videoHeight: 0,
    rect: { left: 0, top: 0, right: 0, bottom: 0 },
  })] });
  assert.equal(result.video.url, cdn());
  assert.equal(result.video.source, 'matchedCurrentSrc');
  assert.equal(result.video.width, 0);
  assert.equal(result.video.videoId, target);
});

test('hidden exact-ID fallback needs a specific page video identity', () => {
  const result = run({ href: 'https://www.douyin.com/', videos: [video({ style: { display: 'none' } })] });
  assert.equal(result.video, null);
});

test('unsupported origin never yields a download even with a legitimate CDN', () => {
  const result = run({ href: `https://example.com/video/${target}`, videos: [video()] });
  assert.equal(result.video, null);
  assert.match(result.reason, /抖音/);
});

test('rejects untrusted hosts, credentials, local URLs, insecure and nonvideo endpoints', () => {
  for (const currentSrc of [
    'https://evil.example/clip.mp4', 'http://v26-web.douyinvod.com/clip.mp4',
    'https://douyinvod.com.evil.example/clip.mp4', 'https://evil@v26-web.douyinvod.com/clip.mp4',
    'https://127.0.0.1/clip.mp4', 'https://www.douyin.com/aweme/v1/delete/',
    'https://v26-web.douyinvod.com:8080/clip.mp4', 'javascript:alert(1)',
  ]) assert.equal(run({ videos: [video({ currentSrc })] }).video, null, currentSrc);
});

test('allows protocol-relative CDN addresses and known signed play endpoints', () => {
  for (const currentSrc of [
    '//v26-web.douyinvod.com/clip.mp4',
    'https://v11-web.douyinvod.com.cn/clip.mp4',
    'https://www.douyin.com/aweme/v1/play/?video_id=v0200ab&sign=abc',
    'https://aweme.snssdk.com/aweme/v1/play/?video_id=v0200ab&sign=abc',
  ]) assert.ok(run({ videos: [video({ currentSrc })] }).video, currentSrc);
});

test('modal_id selects the target and rejects recommendations', () => {
  const result = run({ href: `https://www.douyin.com/?modal_id=${target}`, videos: [video({ currentSrc: cdn(other) }), video()] });
  assert.equal(result.videoId, target);
  assert.equal(result.video.url, cdn());
});

test('percent-encoded RENDER_DATA selects only metadata for the requested video', () => {
  const render = encodeURIComponent(JSON.stringify({ app: { items: [
    { aweme_id: other, desc: 'Unrelated', video: { width: 3840, height: 2160, play_addr: { url_list: [cdn(other)] } } },
    { aweme_id: target, desc: '正确视频', video: { width: 1280, height: 720, duration: 19067,
      play_addr: { url_list: [cdn()] }, cover: { url_list: ['https://p3.douyinpic.com/poster.jpg'] } } },
  ] } }));
  const result = run({ render, videos: [video({ currentSrc: 'blob:https://www.douyin.com/abc' })] });
  assert.equal(result.video.url, cdn());
  assert.equal(result.video.title, '正确视频');
  assert.equal(result.video.width, 1280);
  assert.equal(result.video.duration, 19.067);
  assert.equal(result.video.poster, 'https://p3.douyinpic.com/poster.jpg');
  assert.equal(result.video.source, 'metadata');
});

test('raw camel-case RENDER_DATA is supported', () => {
  const router = { loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [
    { awemeId: target, desc: 'Router title', video: { width: 960, height: 540, duration: 12000, playAddr: [{ src: cdn() }] } },
  ] } } } };
  assert.equal(run({ render: JSON.stringify(router) }).video.duration, 12);
});

test('isolated world reads a router assignment from shared inline script text', () => {
  const router = { loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [
    { aweme_id: target, desc: 'Shared script: {brace} and "quoted" title', video: {
      width: 960, height: 540, duration: 12000, play_addr: { url_list: [cdn()] },
    } },
  ] } } } };
  const script = `window._ROUTER_DATA = ${JSON.stringify(router)}; throw new Error('must not execute');`;
  const result = run({ scripts: [script] });
  assert.equal(result.video.source, 'metadata');
  assert.equal(result.video.url, cdn());
  assert.equal(result.video.title, 'Shared script: {brace} and "quoted" title');
  assert.equal(result.video.duration, 12);
});

test('inline router supports JSON.parse with a JSON string literal without evaluating code', () => {
  const json = JSON.stringify({ awemeId: target, desc: 'JSON literal', video: { playAddr: [{ src: cdn() }] } });
  const script = `window._ROUTER_DATA = JSON.parse(${JSON.stringify(json)}); globalThis.sideEffect();`;
  assert.equal(run({ scripts: [script] }).video.title, 'JSON literal');
});

test('malformed scripts and executable expressions are not evaluated as router data', () => {
  for (const script of [
    'window._ROUTER_DATA = { malformed JSON };',
    'window._ROUTER_DATA = (() => { throw new Error("do not run"); })();',
    'window._ROUTER_DATA = JSON.parse(globalThis.sideEffect());',
    'window._ROUTER_DATA = {"unterminated": [};',
    'window._ROUTER_DATA = JSON.parse("unterminated);',
  ]) assert.equal(run({ scripts: [script] }).video, null, script);
});

test('quoted and commented router assignments are ignored', () => {
  const json = JSON.stringify({ aweme_id: target, video: { play_addr: { url_list: [cdn()] } } });
  for (const script of [
    `// window._ROUTER_DATA = ${json};`,
    `/* window._ROUTER_DATA = ${json}; */`,
    `const example = 'window._ROUTER_DATA = ${json}';`,
  ]) assert.equal(run({ scripts: [script] }).video, null, script);
});

test('inline script scanning has count and size limits', () => {
  const json = JSON.stringify({ aweme_id: target, video: { play_addr: { url_list: [cdn()] } } });
  const script = `window._ROUTER_DATA = ${json};`;
  assert.equal(run({ scripts: [' '.repeat(3000001) + script] }).video, null);
  assert.equal(run({ scripts: [...Array(200).fill('void 0;'), script] }).video, null);
  assert.equal(run({ scripts: [' '.repeat(2000001), ' '.repeat(2000001), script] }).video, null);
});

test('current playback wins over higher resolution SSR metadata', () => {
  const render = JSON.stringify({ aweme_id: target, video: { width: 1920, height: 1080, play_addr: { url_list: [cdn(target, '&hd=1')] } } });
  assert.equal(run({ videos: [video()], render }).video.url, cdn());
});

test('performance fallback needs an explicit matching video identity', () => {
  const result = run({ resources: [cdn(), 'https://v26-web.douyinvod.com/untagged/', cdn(other)] });
  assert.equal(result.video.url, cdn());
  assert.equal(result.video.source, 'performance');
  assert.equal(run({ resources: [cdn(other)] }).video, null);
  assert.equal(run({ href: 'https://www.douyin.com/', resources: [cdn()] }).video, null);
});

test('malformed or unrelated metadata does not fall back to another video', () => {
  assert.equal(run({ render: 'self.evil()' }).video, null);
  const render = JSON.stringify({ aweme_id: other, video: { play_addr: { url_list: ['https://v26-web.douyinvod.com/untagged/'] } } });
  assert.equal(run({ render }).video, null);
  assert.equal(run({ render: 'x'.repeat(3000001) }).video, null);
});

test('unknown dimensions and infinite media duration remain serializable', () => {
  const result = run({ videos: [video({ videoWidth: 0, videoHeight: 0, duration: Infinity, poster: 'javascript:alert(1)' })] });
  assert.equal(result.video.duration, 0);
  assert.equal(result.video.poster, '');
});
