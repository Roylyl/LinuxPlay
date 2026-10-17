// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const dbus = require('dbus-next');
const {Interface, ACCESS_READ, ACCESS_READWRITE} = dbus.interface;
const {Variant, DBusError} = dbus;

const BUS_NAME = 'org.mpris.MediaPlayer2.linuxplay';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const microseconds = value => BigInt(Math.round(number(value) * 1000));
const read = signature => ({signature, access:ACCESS_READ});
const readwrite = signature => ({signature, access:ACCESS_READWRITE});

function sessionAddress() {
 const address = process.env.DBUS_SESSION_BUS_ADDRESS;
 if (!address) {
  const socket = process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, 'bus');
  return socket && fs.existsSync(socket) ? `unix:socket=${socket}` : undefined;
 }
 // MPRIS sends no file descriptors. Use Node's Unix sockets for both filesystem
 // and abstract addresses, avoiding native addons tied to a Node/Electron ABI.
 return address.split(';').map(value => {
  if (!value.startsWith('unix:')) return value;
  const match = value.match(/(?:^unix:|,)(path|abstract)=([^,]*)/);
  return match ? `unix:socket=${match[1] === 'abstract' ? '\0' : ''}${decodeURIComponent(match[2])}` : value;
 }).join(';');
}

class ApplicationInterface extends Interface {
 constructor() {
  super('org.mpris.MediaPlayer2');
  Object.assign(this, {CanQuit:false, CanRaise:false, HasTrackList:false, Identity:'LinuxPlay', DesktopEntry:'linuxplay', SupportedUriSchemes:[], SupportedMimeTypes:[]});
 }
 Raise() {}
 Quit() {}
}
ApplicationInterface.configureMembers({
 properties:{CanQuit:read('b'), CanRaise:read('b'), HasTrackList:read('b'), Identity:read('s'), DesktopEntry:read('s'), SupportedUriSchemes:read('as'), SupportedMimeTypes:read('as')},
 methods:{Raise:{}, Quit:{}}
});

class PlayerInterface extends Interface {
 constructor(service) { super(PLAYER_INTERFACE); this.service = service; }
 get PlaybackStatus() { return !this.service.state ? 'Stopped' : this.service.state.playing ? 'Playing' : 'Paused'; }
 get Metadata() { return this.service.metadata; }
 get Position() { return microseconds(this.service.position()); }
 get Rate() { return 1; }
 set Rate(value) { if (value === 0) this.Pause(); }
 get MinimumRate() { return 1; }
 get MaximumRate() { return 1; }
 // The phone owns volume and playback speed; the bridge never changes audio routing.
 get Volume() { return 1; }
 set Volume(_value) { throw new DBusError('org.freedesktop.DBus.Error.NotSupported', '音量由iPhone和系统音频设置控制'); }
 get CanControl() { return true; }
 get CanGoNext() { return !!this.service.state; }
 get CanGoPrevious() { return !!this.service.state; }
 get CanPlay() { return !!this.service.state; }
 get CanPause() { return !!this.service.state; }
 get CanSeek() { return !!this.service.state?.canSeek && this.service.duration > 0; }
 Next() { this.service.media(4); }
 Previous() { this.service.media(5); }
 Pause() { if (this.service.state?.playing) this.service.media(2); }
 PlayPause() { this.service.media(3); }
 Stop() { this.Pause(); }
 Play() { if (this.service.state && !this.service.state.playing) this.service.media(1); }
 Seek(offset) {
  if (!this.CanSeek) return;
  const target = this.service.position() + Number(offset) / 1000;
  if (target > this.service.duration) this.Next();
  else this.service.seek(Math.max(0, target));
 }
 SetPosition(trackId, position) {
  const target = Number(position) / 1000;
  if (this.CanSeek && trackId === this.service.trackPath && target >= 0 && target <= this.service.duration) this.service.seek(target);
 }
 OpenUri(_uri) { throw new DBusError('org.freedesktop.DBus.Error.NotSupported', '请在iPhone上选择媒体'); }
 Seeked(position) { return position; }
}
PlayerInterface.configureMembers({
 properties:{PlaybackStatus:read('s'), Metadata:read('a{sv}'), Position:read('x'), Rate:readwrite('d'), MinimumRate:read('d'), MaximumRate:read('d'), Volume:readwrite('d'), CanControl:read('b'), CanGoNext:read('b'), CanGoPrevious:read('b'), CanPlay:read('b'), CanPause:read('b'), CanSeek:read('b')},
 methods:{Next:{}, Previous:{}, Pause:{}, PlayPause:{}, Stop:{}, Play:{}, Seek:{inSignature:'x'}, SetPosition:{inSignature:'ox'}, OpenUri:{inSignature:'s'}},
 signals:{Seeked:{signature:'x'}}
});

class MprisService {
 constructor(onCommand, onError) {
  Object.assign(this, {onCommand, onError, state:null, metadata:{}, duration:0, basePosition:0, stamp:performance.now(), trackSerial:0, coverSerial:0, ownsName:false, disposed:false});
  this.application = new ApplicationInterface();
  this.player = new PlayerInterface(this);
 }

 async start() {
  this.bus = dbus.sessionBus({busAddress:sessionAddress()});
  this.bus.on('error', error => { if (!this.disposed) this.onError(error); });
  // dbus-next exposes socket EOF only on its connection, rather than MessageBus.
  this.bus._connection.on('end', () => { if (!this.disposed) this.onError(Error('会话总线连接已断开')); });
  // Request/release confirms that the session bus is reachable before reporting ready.
  // The public player exists only while the receiver has current media metadata.
  await this.claimName();
  this.bus.export(OBJECT_PATH, this.application);
  this.bus.export(OBJECT_PATH, this.player);
  await this.bus.releaseName(BUS_NAME);
  this.ownsName = false;
 }

 async claimName() {
  if (this.disposed || this.ownsName) return;
  const result = await this.bus.requestName(BUS_NAME, 4); // DO_NOT_QUEUE
  if (result !== 1 && result !== 4) throw Error('LinuxPlay系统媒体会话名称已被占用');
  this.ownsName = true;
 }

 position() {
  if (!this.state || this.duration === 0) return 0;
  return Math.min(this.duration, Math.max(0, this.basePosition + (this.state.playing ? performance.now() - this.stamp : 0)));
 }

 setPosition(position, notify = true) {
  const previous = this.position();
  this.basePosition = Math.min(this.duration, number(position));
  this.stamp = performance.now();
  // MPRIS clients extrapolate ordinary playback themselves. Correct discontinuities.
  if (notify && Math.abs(previous - this.basePosition) > 1000) this.player.Seeked(microseconds(this.basePosition));
 }

 media(index) { if (this.state) this.onCommand({type:'command', command:'media', index}); }

 seek(position) {
  this.setPosition(position, false);
  this.onCommand({type:'command', command:'seek', ms:Math.round(this.basePosition)});
  this.player.Seeked(microseconds(this.basePosition));
 }

 updateArtwork(message) {
  if (!message.artChanged) return;
  const previous = this.coverPath;
  this.coverPath = undefined;
  if (message.artwork) {
   const bytes = Buffer.from(message.artwork, 'base64');
   if (!this.coverDirectory) this.coverDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'linuxplay-media-'));
   this.coverPath = path.join(this.coverDirectory, `cover-${++this.coverSerial}.${bytes[0] === 137 ? 'png' : 'jpg'}`);
   fs.writeFileSync(this.coverPath, bytes, {mode:0o600});
  }
  if (previous) fs.rmSync(previous, {force:true});
 }

 async update(message) {
  if (this.disposed) return;
  const key = JSON.stringify([message.appId || '', message.trackId || '', message.generation || 0]);
  if (!this.state || key !== this.trackKey) this.trackPath = `/io/github/roylyl/linuxplay/track/${++this.trackSerial}`;
  this.trackKey = key;
  this.updateArtwork(message);
  this.duration = number(message.durationMs);
  this.state = {...message, playing:!!message.playing, canSeek:!!message.canSeek};
  this.setPosition(message.positionMs, false);
  this.metadata = {
   'mpris:trackid':new Variant('o', this.trackPath),
   'mpris:length':new Variant('x', microseconds(this.duration)),
   'xesam:title':new Variant('s', String(message.title || '')),
   'xesam:artist':new Variant('as', message.artist ? [String(message.artist)] : []),
   'xesam:album':new Variant('s', String(message.album || ''))
  };
  if (this.coverPath) this.metadata['mpris:artUrl'] = new Variant('s', pathToFileURL(this.coverPath).href);
  await this.claimName();
  if (this.disposed) return;
  Interface.emitPropertiesChanged(this.player, {Metadata:this.metadata, PlaybackStatus:this.player.PlaybackStatus, CanGoNext:true, CanGoPrevious:true, CanPlay:true, CanPause:true, CanSeek:this.player.CanSeek});
  this.player.Seeked(microseconds(this.basePosition));
 }

 async clear() {
  this.state = null;
  this.metadata = {};
  this.duration = this.basePosition = 0;
  this.updateArtwork({artChanged:true});
  if (!this.ownsName || this.disposed) return;
  Interface.emitPropertiesChanged(this.player, {Metadata:{}, PlaybackStatus:'Stopped', CanGoNext:false, CanGoPrevious:false, CanPlay:false, CanPause:false, CanSeek:false});
  await this.bus.releaseName(BUS_NAME);
  this.ownsName = false;
 }

 dispose() {
  if (this.disposed) return;
  this.disposed = true;
  this.state = null;
  this.bus?.disconnect();
  if (this.coverDirectory) fs.rmSync(this.coverDirectory, {recursive:true, force:true});
 }
}

module.exports = {MprisService, BUS_NAME, OBJECT_PATH, PLAYER_INTERFACE};
