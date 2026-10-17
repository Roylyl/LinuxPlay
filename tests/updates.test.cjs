const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Updates} = require('../src/updates.cjs');
const nativeArchitecture = {x64: {AppImage: 'x86_64', deb: 'amd64'}, arm64: {AppImage: 'arm64', deb: 'arm64'}, arm: {AppImage: 'armv7l', deb: 'armhf'}}[process.arch];

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linuxplay-updates-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function release(version, extra = {}) {
  const name = `LinuxPlay-${version}-${nativeArchitecture.AppImage}.AppImage`;
  return {
    tag_name: `LinuxPlay-${version}`, html_url: `https://github.com/Roylyl/LinuxPlay/releases/tag/LinuxPlay-${version}`,
    draft: false, prerelease: false,
    assets: [{name, browser_download_url: `https://github.com/Roylyl/LinuxPlay/releases/download/LinuxPlay-${version}/${name}`}],
    ...extra
  };
}
function response(items) { return new Response(JSON.stringify(items), {status: 200}); }

test('unified V/v tags retain their actual download paths and survive cached restart', async t => {
  for (const tag of ['V1.2.0','v1.2.0','LinuxPlay-1.2.0','1.2.0']) {
    const dir=directory(t), name=`LinuxPlay-1.2.0-${nativeArchitecture.AppImage}.AppImage`;
    const page=`https://github.com/Roylyl/LinuxPlay/releases/tag/${tag}`;
    const installer=`https://github.com/Roylyl/LinuxPlay/releases/download/${tag}/${name}`;
    const updates=new Updates({version:'1.1.0',dataDir:dir,fetchImpl:async()=>response([release('1.2.0',{tag_name:tag,html_url:page,assets:[{name,browser_download_url:installer}]})])});
    const state=await updates.check();assert.equal(state.status,'发现新版本');assert.equal(state.release.version,'1.2.0');assert.equal(updates.releaseUrl(),page);assert.equal(updates.downloadUrl(),installer);
    const restored=new Updates({version:'1.1.0',dataDir:dir});assert.equal(restored.downloadUrl(),installer);assert.equal(restored.releaseUrl(),page);
  }
});

test('V tags reject mismatched asset tags, prereleases and malformed numeric versions', async t => {
  const updates=new Updates({version:'1.1.0',dataDir:directory(t),fetchImpl:async()=>response([
    release('9.0.0',{tag_name:'V9.0.0',prerelease:true}),release('8.0.0',{tag_name:'V8.0.0-beta'}),release('7.0.0',{tag_name:'V07.0.0'}),
    release('1.2.0',{tag_name:'V1.2.0',html_url:'https://evil.example/'})
  ])});
  await updates.check();assert.equal(updates.state().release.version,'1.2.0');assert.equal(updates.state().release.installer,null);assert.equal(updates.releaseUrl(),'https://github.com/Roylyl/LinuxPlay/releases/tag/V1.2.0');
});

test('uses only LinuxPlay releases, compares numeric versions and excludes nonstable tags', async t => {
  const changes = [], calls = [];
  const updates = new Updates({version: '1.1.0', dataDir: directory(t), onChange: state => changes.push(state), fetchImpl: async (url, options) => {
    calls.push({url, options});
    return response([release('1.9.9'), release('1.10.0'), release('9.0.0', {prerelease: true}), release('8.0.0', {draft: true}), release('7.0.0', {tag_name: 'MacPlay-7.0.0'}), release('7.0.1', {tag_name: 'WinPlay-7.0.1'}), release('6.0.0', {tag_name: 'LinuxPlay-6.0.0-beta.1'}), release('5.0.0', {tag_name: 'LinuxPlay-05.0.0'})]);
  }});
  assert.equal(calls.length, 0, 'construction does not start a request');
  assert.equal(updates.state().automatic, true);
  const state = await updates.check();
  assert.equal(state.release.version, '1.10.0');
  assert.equal(state.status, '发现新版本');
  assert.equal(state.checking, false);
  assert.equal(calls[0].url, 'https://api.github.com/repos/Roylyl/LinuxPlay/releases?per_page=100');
  assert.equal(calls[0].options.headers['User-Agent'], 'LinuxPlay/1.1.0');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(changes[0].checking, true);
  assert.equal(changes.at(-1).checking, false);
  state.release.version = '99.0.0';
  assert.equal(updates.state().release.version, '1.10.0', 'state snapshots cannot mutate the module');
});

test('merges concurrent checks, persists automatic throttle and allows manual retry', async t => {
  let finish, calls = 0;
  const dir = directory(t);
  const updates = new Updates({version: '1.1.0', dataDir: dir, fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); }});
  const first = updates.check({automatic: true});
  assert.equal(updates.check(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(response([release('1.2.0')]));
  await first;
  await updates.check({automatic: true});
  assert.equal(calls, 1);
  const restored = new Updates({version: '1.1.0', dataDir: dir, fetchImpl: async () => { calls++; return response([release('1.3.0')]); }});
  await restored.check({automatic: true});
  assert.equal(calls, 1, 'restart retains the automatic interval');
  await restored.check();
  assert.equal(calls, 2, 'manual check bypasses the automatic interval');
  await restored.setAutomatic(false);
  assert.equal(restored.state().automatic, false);
  await restored.check({automatic: true});
  assert.equal(calls, 2);
  assert.equal(new Updates({version: '1.1.0', dataDir: dir}).state().automatic, false);
});

test('startup bypasses recent checks, background interval is two hours, and disabling still wins',async t=>{
 const {AUTO_CHECK_INTERVAL_MS}=require('../src/updates.cjs');assert.equal(AUTO_CHECK_INTERVAL_MS,7200000);
 let calls=0;const dir=directory(t),fetchImpl=async()=>{calls++;return response([])};
 const updates=new Updates({version:'1.2.2',dataDir:dir,fetchImpl});await updates.check({automatic:true});
 const restored=new Updates({version:'1.2.2',dataDir:dir,fetchImpl});await restored.check({automatic:true,force:true});assert.equal(calls,2);
 await restored.check({automatic:true});assert.equal(calls,2);
 restored.lastCheck=Date.now()-AUTO_CHECK_INTERVAL_MS;await restored.check({automatic:true});assert.equal(calls,3);
 await restored.setAutomatic(false);await restored.check({automatic:true,force:true});assert.equal(calls,3);
});

test('startup creates a continuing background timer without foreground prompts',async()=>{
 const vm=require('node:vm'),source=fs.readFileSync(require.resolve('../src/main.cjs'),'utf8');
 const checks=[],prompts=[],timeouts=[],intervals=[];
 const context={closing:false,AUTO_CHECK_INTERVAL_MS:7200000,updates:{check:async options=>{checks.push(options);return {automatic:true,status:'发现新版本'}}},promptUpdate:async()=>prompts.push(true),setTimeout:(fn,ms)=>{timeouts.push({fn,ms});return {}},setInterval:(fn,ms)=>{intervals.push({fn,ms});return {}}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('let updateStartupTimer'),source.indexOf('function log(')),context);
 context.startUpdateChecks();assert.equal(timeouts[0].ms,5000);timeouts[0].fn();await Promise.resolve();
 assert.equal(checks.length,1);assert.equal(prompts.length,1);assert.equal(intervals[0].ms,7200000);
 intervals[0].fn();await Promise.resolve();assert.equal(checks.length,2);assert.equal(prompts.length,1);assert.equal(checks[1].force,true);
 context.closing=true;intervals[0].fn();assert.equal(checks.length,2);
});

test('notifies once per version and retains safe links after failed requests', async t => {
  const dir = directory(t);
  let fail = false;
  const updates = new Updates({version: '1.1.0', dataDir: dir, fetchImpl: async () => fail ? new Response('', {status: 403}) : response([release('1.2.0')])});
  await updates.check();
  assert.equal(updates.shouldNotify(), true);
  updates.markNotified();
  assert.equal(updates.shouldNotify(), false);
  const restored = new Updates({version: '1.1.0', dataDir: dir});
  assert.equal(restored.shouldNotify(), false);
  assert.equal(restored.downloadUrl(), `https://github.com/Roylyl/LinuxPlay/releases/download/LinuxPlay-1.2.0/LinuxPlay-1.2.0-${nativeArchitecture.AppImage}.AppImage`);
  fail = true;
  await updates.check();
  assert.equal(updates.state().status, '检查更新失败');
  assert.equal(updates.state().detail, 'GitHub HTTP403');
  assert.equal(updates.state().release.version, '1.2.0');
  assert.equal(updates.shouldNotify(), false);
  const upgraded = new Updates({version: '1.2.0', dataDir: dir});
  assert.equal(upgraded.state().release, null, 'old cached update is removed after upgrade');
});

test('requires an exact native-architecture Linux asset from this repository and falls back to the release page', async t => {
  const malicious = [
    `https://evil.example/LinuxPlay-1.2.0-${nativeArchitecture.AppImage}.AppImage`,
    `https://github.com/Roylyl/MacPlay/releases/download/LinuxPlay-1.2.0/LinuxPlay-1.2.0-${nativeArchitecture.AppImage}.AppImage`,
    `https://github.com.evil.example/Roylyl/LinuxPlay/releases/download/LinuxPlay-1.2.0/LinuxPlay-1.2.0-${nativeArchitecture.AppImage}.AppImage`,
    `http://github.com/Roylyl/LinuxPlay/releases/download/LinuxPlay-1.2.0/LinuxPlay-1.2.0-${nativeArchitecture.AppImage}.AppImage`,
    `https://user:password@github.com/Roylyl/LinuxPlay/releases/download/LinuxPlay-1.2.0/LinuxPlay-1.2.0-${nativeArchitecture.AppImage}.AppImage`,
    `https://github.com/Roylyl/LinuxPlay/releases/download/LinuxPlay-1.2.0/LinuxPlay-1.2.0-${nativeArchitecture.AppImage}.AppImage?redirect=evil`
  ];
  for (const browser_download_url of malicious) {
    const updates = new Updates({version: '1.1.0', dataDir: directory(t), fetchImpl: async () => response([release('1.2.0', {html_url: 'https://evil.example/', assets: [{name: `LinuxPlay-1.2.0-${nativeArchitecture.AppImage}.AppImage`, browser_download_url}]})])});
    await updates.check();
    assert.equal(updates.state().release.installer, null);
    assert.equal(updates.releaseUrl(), 'https://github.com/Roylyl/LinuxPlay/releases/tag/LinuxPlay-1.2.0');
    assert.equal(updates.downloadUrl(), updates.releaseUrl());
  }
});

test('prefers AppImage and falls back to DEB while preserving either format in cache', async t => {
  const appImage = release('1.2.0').assets[0];
  const debName = `LinuxPlay-1.2.0-${nativeArchitecture.deb}.deb`;
  const deb = {name: debName, browser_download_url: `https://github.com/Roylyl/LinuxPlay/releases/download/LinuxPlay-1.2.0/${debName}`};
  for (const [assets, expected] of [[[deb, appImage], appImage], [[deb], deb]]) {
    const dir = directory(t);
    const updates = new Updates({version: '1.1.0', dataDir: dir, fetchImpl: async () => response([release('1.2.0', {assets})])});
    await updates.check();
    assert.equal(updates.downloadUrl(), expected.browser_download_url);
    assert.equal(new Updates({version: '1.1.0', dataDir: dir}).downloadUrl(), expected.browser_download_url);
  }
});

test('uses electron-builder architecture names for AppImage and DEB and rejects unsupported hosts', async t => {
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../src/updates.cjs'), 'utf8');
  for (const [arch, appImageArch, debArch] of [['x64', 'x86_64', 'amd64'], ['arm64', 'arm64', 'arm64'], ['arm', 'armv7l', 'armhf'], ['ppc64', 'x86_64', 'amd64']]) {
    const context = {require, module: {exports: {}}, process: {arch}, URL, Buffer, AbortController, setTimeout, clearTimeout, fetch: globalThis.fetch};
    vm.runInNewContext(source, context);
    const PlatformUpdates = context.module.exports.Updates;
    const assets = [['AppImage', appImageArch], ['deb', debArch]].map(([extension, assetArch]) => {
      const name = `LinuxPlay-1.2.0-${assetArch}.${extension}`;
      return {name, browser_download_url: `https://github.com/Roylyl/LinuxPlay/releases/download/LinuxPlay-1.2.0/${name}`};
    });
    for (const available of [assets, assets.slice(1)]) {
      const dir = directory(t), fetchImpl = async () => response([release('1.2.0', {assets: available})]);
      const updates = new PlatformUpdates({version: '1.1.0', dataDir: dir, fetchImpl});
      await updates.check();
      const expected = arch === 'ppc64' ? null : available[0].browser_download_url;
      assert.equal(updates.state().release.installer, expected);
      assert.equal(new PlatformUpdates({version: '1.1.0', dataDir: dir}).state().release.installer, expected);
    }
  }
});

test('rejects foreign architectures and Windows installers both in release assets and cache', async t => {
  const foreign = process.arch === 'arm64' ? {AppImage: 'x86_64', deb: 'amd64'} : {AppImage: 'arm64', deb: 'arm64'};
  for (const name of [`LinuxPlay-1.2.0-${foreign.AppImage}.AppImage`, `LinuxPlay-1.2.0-${foreign.deb}.deb`, 'LinuxPlay-1.2.0-x64.AppImage', 'LinuxPlay-1.2.0-x64.deb', `LinuxPlay-1.2.0-Setup-${process.arch}.exe`, 'WinPlay-1.2.0-Setup-x64.exe']) {
    const installer = `https://github.com/Roylyl/LinuxPlay/releases/download/LinuxPlay-1.2.0/${name}`;
    const dir = directory(t);
    const updates = new Updates({version: '1.1.0', dataDir: dir, fetchImpl: async () => response([release('1.2.0', {assets: [{name, browser_download_url: installer}]})])});
    await updates.check();assert.equal(updates.state().release.installer, null);
    fs.writeFileSync(path.join(dir, 'updates.json'), JSON.stringify({release: {version: '1.2.0', tag: 'LinuxPlay-1.2.0', installer}}));
    assert.equal(new Updates({version: '1.1.0', dataDir: dir}).state().release.installer, null);
  }
});

test('bounds response size and handles malformed JSON/timeout without exposing error details', async t => {
  const cases = [
    {fetchImpl: async () => new Response('[]', {headers: {'content-length': String(5 * 1024 * 1024)}}), detail: '发行信息过大，请查看发行说明'},
    {fetchImpl: async () => new Response('a'.repeat(4 * 1024 * 1024 + 1)), detail: '发行信息过大，请查看发行说明'},
    {fetchImpl: async () => new Response('not-json'), detail: '无法读取GitHub发行信息，请稍后重试'},
    {fetchImpl: async () => { throw Object.assign(new Error('private local details'), {name: 'AbortError'}); }, detail: '请求超时，请稍后重试'}
  ];
  for (const item of cases) {
    let calls = 0;
    const updates = new Updates({version: '1.1.0', dataDir: directory(t), fetchImpl: (...args) => { calls++; return item.fetchImpl(...args); }});
    await updates.check({automatic: true});
    assert.equal(updates.state().status, '检查更新失败');
    assert.equal(updates.state().detail, item.detail);
    assert.equal(updates.state().checking, false);
    await updates.check({automatic: true});
    assert.equal(calls, 1, 'automatic failures are also throttled');
  }
});

test('same version is current, missing stable releases are explicit and invalid cache is ignored', async t => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'updates.json'), JSON.stringify({automatic: 'wrong', lastCheck: Date.now() + 86400000, notifiedVersion: 'broken', release: {version: '1.2.0', page: 'javascript:alert(1)', installer: 'file:///C:/private.exe'}}));
  const updates = new Updates({version: '1.1.0', dataDir: dir, fetchImpl: async () => response([release('1.1.0')])});
  assert.equal(updates.state().automatic, true);
  assert.equal(updates.state().release.installer, null);
  assert.equal(updates.releaseUrl(), 'https://github.com/Roylyl/LinuxPlay/releases/tag/LinuxPlay-1.2.0');
  await updates.check({automatic: true});
  assert.equal(updates.state().status, '当前已是最新版本');
  assert.equal(updates.state().release, null);
  assert.equal(updates.shouldNotify(), false);
  assert.equal(updates.downloadUrl(), 'https://github.com/Roylyl/LinuxPlay/releases');
  const empty = new Updates({version: '1.1.0', dataDir: directory(t), fetchImpl: async () => response([release('1.2.0', {prerelease: true})])});
  await empty.check();
  assert.equal(empty.state().status, '未找到正式发行版');
  assert.equal(empty.state().release, null);
});
