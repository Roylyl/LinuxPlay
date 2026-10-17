const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fileURLToPath, pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {createInterface} = require('node:readline');
const dbus = require('dbus-next');
const {BUS_NAME, OBJECT_PATH, PLAYER_INTERFACE} = require('../../src/mpris-service.cjs');

const child = spawn(process.execPath, [path.join(__dirname, '../../src/mpris-bridge.cjs')], {env:{...process.env, ELECTRON_RUN_AS_NODE:'1'}});
const messages = [];
let errors = '';
child.stderr.on('data', data => { errors += data; });
createInterface({input:child.stdout}).on('line', line => messages.push(JSON.parse(line)));
const bus = dbus.sessionBus();
bus.on('error', error => { throw error; });
const write = message => child.stdin.write(JSON.stringify(message) + '\n');
async function wait(predicate, label) {
 for (let i = 0; i < 100; i++) {
  if (child.exitCode !== null) throw Error(errors || `bridge exited: ${child.exitCode}`);
  const value = await predicate();
  if (value) return value;
  await new Promise(resolve => setTimeout(resolve, 20));
 }
 throw Error(`MPRIS timeout: ${label}; ${errors}`);
}

(async () => {
 let coverPath;
 try {
  await wait(() => messages.find(message => message.type === 'ready'), 'ready');
  const daemon = (await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')).getInterface('org.freedesktop.DBus');
  assert.ok(!(await daemon.ListNames()).includes(BUS_NAME), 'idle receiver does not publish an empty media player');
  const cover = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const state = {title:'LinuxPlay MPRIS test', artist:'Fixture', album:'Album', trackId:'1', generation:0, playing:true, canSeek:true, durationMs:120000, positionMs:2000};
  write({command:'update', ...state, artChanged:true, artwork:cover.toString('base64')});
  await wait(async () => (await daemon.ListNames()).includes(BUS_NAME), 'player registration');
  const object = await bus.getProxyObject(BUS_NAME, OBJECT_PATH);
  const properties = object.getInterface('org.freedesktop.DBus.Properties');
  const player = object.getInterface(PLAYER_INTERFACE);
  const get = async property => (await properties.Get(PLAYER_INTERFACE, property)).value;
  let metadata = await get('Metadata');
  assert.equal(metadata['xesam:title'].value, state.title);
  assert.deepEqual(metadata['xesam:artist'].value, ['Fixture']);
  assert.equal(metadata['xesam:album'].value, 'Album');
  assert.equal(metadata['mpris:length'].value, 120000000n);
  assert.equal(await get('PlaybackStatus'), 'Playing');
  assert.ok(await get('CanSeek'));
  const trackPath = metadata['mpris:trackid'].value;
  coverPath = fileURLToPath(metadata['mpris:artUrl'].value);
  assert.deepEqual(fs.readFileSync(coverPath), cover);
  assert.ok(Number(await get('Position')) >= 2000000, 'position follows real playback');

  write({command:'update', ...state, title:'歌词更新', playing:false, positionMs:3000, artChanged:false});
  await wait(async () => (await get('Metadata'))['xesam:title'].value === '歌词更新', 'lyric update');
  metadata = await get('Metadata');
  assert.equal(await get('PlaybackStatus'), 'Paused');
  assert.equal(await get('Position'), 3000000n);
  assert.equal(metadata['mpris:artUrl'].value, pathToFileURL(coverPath).href);
  assert.equal(metadata['mpris:trackid'].value, trackPath, 'lyrics preserve the current track identity');
  assert.ok(fs.existsSync(coverPath));

  await player.Play();
  await player.PlayPause();
  await player.Next();
  await player.Previous();
  for (const index of [1, 3, 4, 5]) await wait(() => messages.some(message => message.command === 'media' && message.index === index), `media ${index}`);
  await player.SetPosition(trackPath, 5000000n);
  await wait(() => messages.some(message => message.command === 'seek' && message.ms === 5000), 'absolute seek');
  await player.Seek(-1000000n);
  await wait(() => messages.some(message => message.command === 'seek' && message.ms === 4000), 'relative seek');
  const count = messages.length;
  await player.SetPosition('/io/github/roylyl/linuxplay/track/stale', 1000000n);
  await player.SetPosition(trackPath, -1n);
  await player.SetPosition(trackPath, 130000000n);
  assert.equal(messages.length, count, 'invalid or stale seek requests never reach the phone');

  write({command:'update', ...state, title:'LinuxPlay MPRIS test', artChanged:false});
  await wait(async () => (await get('PlaybackStatus')) === 'Playing', 'resume');
  await player.Pause();
  await wait(() => messages.some(message => message.command === 'media' && message.index === 2), 'pause');
  write({command:'update', ...state, playing:false, durationMs:0, positionMs:5000, artChanged:false});
  await wait(async () => !(await get('CanSeek')), 'unseekable stream');
  assert.equal(await get('Position'), 0n);
  const before = messages.filter(message => message.command === 'seek').length;
  await player.Seek(1000000n);
  await player.SetPosition(trackPath, 1000000n);
  assert.equal(messages.filter(message => message.command === 'seek').length, before);

  write({command:'clear'});
  await wait(async () => !(await daemon.ListNames()).includes(BUS_NAME), 'session removal');
  assert.ok(!fs.existsSync(coverPath), 'clear releases the album cover');
  write({command:'update', ...state, trackId:'2', playing:false, artChanged:true, artwork:cover.toString('base64')});
  await wait(async () => (await daemon.ListNames()).includes(BUS_NAME), 're-registration');
  const nextObject = await bus.getProxyObject(BUS_NAME, OBJECT_PATH);
  metadata = (await nextObject.getInterface('org.freedesktop.DBus.Properties').Get(PLAYER_INTERFACE, 'Metadata')).value;
  assert.notEqual(metadata['mpris:trackid'].value, trackPath);
  coverPath = fileURLToPath(metadata['mpris:artUrl'].value);
  assert.ok(fs.existsSync(coverPath));
  assert.equal(messages.filter(message => message.type === 'error').length, 0, JSON.stringify(messages));
  const exited = once(child, 'exit');
  child.stdin.end('{"command":"stop"}\n');
  assert.equal((await exited)[0], 0, errors);
  assert.ok(!(await daemon.ListNames()).includes(BUS_NAME));
  assert.ok(!fs.existsSync(path.dirname(coverPath)), 'shutdown removes its temporary cover directory');
 } finally {
  if (child.exitCode === null) child.kill();
  bus.disconnect();
 }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
