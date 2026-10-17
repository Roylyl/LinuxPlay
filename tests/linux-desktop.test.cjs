const test=require('node:test'),assert=require('node:assert/strict');
const {parseMonitors,linuxPhysicalDisplay,linuxContentSize}=require('../src/linux-desktop.cjs');
test('Linux monitor dimensions come from active RandR outputs including negative positions',()=>{
 const monitors=parseMonitors('DP-1 connected 2560x1440-2560+0 (normal)\n   2560x1440 60.00*+\neDP-1 connected primary 3840x2400+0+0 (normal)\n   3840x2400 60.00*+\nHDMI-1 disconnected\nDP-2 connected (normal)');
 assert.equal(monitors.length,2);
 assert.equal(monitors[0].x,-2560);
 assert.equal(monitors[1].primary,true);
 const physical=linuxPhysicalDisplay({label:'eDP-1',scaleFactor:1.5,bounds:{x:0,y:0,width:2560,height:1600}},monitors);
 assert.equal(physical.width,3840);assert.equal(physical.height,2400);assert.equal(physical.verified,true);
 assert.throws(()=>parseMonitors('DP-1 disconnected'),/X11/);
 assert.equal(linuxPhysicalDisplay({scaleFactor:1,bounds:{x:10000,y:0,width:800,height:600}},monitors).verified,false);
});
test('fractional desktop sizing never clips the requested physical viewport',()=>{
 for(const scale of [1,1.25,1.5,1.75,2]){
  const [width,height]=linuxContentSize({width:1280,height:720},scale);
  assert.ok(width*scale>=1280&&width*scale<1280+scale);
  assert.ok(height*scale>=720&&height*scale<720+scale);
 }
});
test('mixed DPI secondary display cannot inherit the primary resolution from its DIP origin',()=>{
 const monitors=parseMonitors('DP-1 connected primary 3840x2160+0+0 (normal)\n   3840x2160 60.00*+\nHDMI-1 connected 1920x1080+3840+0 (normal)\n   1920x1080 60.00*+');
 const physical=linuxPhysicalDisplay({label:'',scaleFactor:1,bounds:{x:1920,y:0,width:1920,height:1080}},monitors);
 assert.equal(physical.width,1920);assert.equal(physical.height,1080);assert.equal(physical.label,'HDMI-1');assert.equal(physical.verified,true);
});
test('GNOME fractional scaling uses current panel mode rather than XWayland render surface',()=>{
 const {parseMutterState}=require('../src/linux-desktop.cjs');
 const spec=['eDP-1','vendor','panel','serial'];
 const modes=[['native',2560,1600,165,1,[1,4/3],{'is-current':{value:true}}],['virtual',3840,2400,165,1,[1],{}]];
 const monitors=parseMutterState([1,[[spec,modes,{}]],[[0,0,4/3,0,true,[spec],{}]],{}]);
 const p=linuxPhysicalDisplay({label:'Built-in display',scaleFactor:2,bounds:{x:0,y:0,width:1920,height:1200}},monitors);
 assert.equal(p.width,2560);assert.equal(p.height,1600);assert.equal(Math.round(p.scaleFactor*100),133);assert.equal(p.pixelScale,4/3);
 assert.deepEqual(linuxContentSize({width:2560,height:1600},p.pixelScale),[1920,1200]);
 const rotated=parseMutterState([1,[[spec,modes,{}]],[[0,0,4/3,1,true,[spec],{}]],{}]);assert.equal(rotated[0].width,1600);assert.equal(rotated[0].height,2560);
});
test('Wayland cannot fall back to certifying virtual RandR dimensions',async()=>{
 const {readLinuxMonitors}=require('../src/linux-desktop.cjs');let called=false;
 await assert.rejects(readLinuxMonitors({env:{XDG_SESSION_TYPE:'wayland'},readMutter:async()=>{throw Error('unavailable')},execute:()=>{called=true}}),/unavailable/);
 assert.equal(called,false);
});
test('RandR transformed desktop rectangles and missing modes do not certify physical pixels',()=>{
 assert.throws(()=>parseMonitors('DP-1 connected 3840x2160+0+0 (normal)\n   1920x1080 60.00*+'),/物理像素/);
 assert.throws(()=>parseMonitors('DP-1 connected 3840x2160+0+0 (normal)\n   3840x2160 60.00'),/物理像素/);
 const rotated=parseMonitors('DP-1 connected 1080x1920+0+0 left (normal left inverted right)\n   1920x1080 60.00*+');
 assert.equal(rotated[0].width,1080);assert.equal(rotated[0].height,1920);
});
test('a matching output label cannot certify inconsistent or malformed pixel geometry',()=>{
 const display={label:'eDP-1',scaleFactor:2,bounds:{x:0,y:0,width:1920,height:1200}};
 assert.equal(linuxPhysicalDisplay(display,[{label:'eDP-1',source:'mutter',scaleFactor:4/3,x:0,y:0,width:2560,height:1440}]).verified,false);
 assert.equal(linuxPhysicalDisplay(display,[{label:'eDP-1',x:0,y:0,width:Infinity,height:1600}]).verified,false);
});
test('GNOME mode changes invalidate display state even when Electron bounds stay unchanged',async()=>{
 const {EventEmitter}=require('node:events'),{watchLinuxMonitors}=require('../src/linux-desktop.cjs');
 const bus=new EventEmitter(),calls=[];let changes=0,disconnects=0;
 bus.call=async message=>{calls.push(message)};bus.disconnect=()=>{disconnects++};
 const close=watchLinuxMonitors(()=>changes++,{env:{XDG_SESSION_TYPE:'wayland',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'},dbus:{sessionBus:()=>bus,Message:class{constructor(value){Object.assign(this,value)}}}});
 assert.equal(calls[0].member,'AddMatch');
 const signal={type:4,path:'/org/gnome/Mutter/DisplayConfig',interface:'org.gnome.Mutter.DisplayConfig',member:'MonitorsChanged'};
 bus.emit('message',signal);assert.equal(changes,1);
 bus.emit('message',{...signal,member:'Unrelated'});assert.equal(changes,1);
 close();bus.emit('message',signal);assert.equal(changes,1);assert.equal(disconnects,1);
});
test('a broken display monitor subscription invalidates cached capabilities once',()=>{
 const {EventEmitter}=require('node:events'),{watchLinuxMonitors}=require('../src/linux-desktop.cjs');
 const bus=new EventEmitter();let changes=0,disconnects=0;
 bus.call=async()=>{};bus.disconnect=()=>disconnects++;
 const close=watchLinuxMonitors(()=>changes++,{env:{WAYLAND_DISPLAY:'wayland-0'},dbus:{sessionBus:()=>bus,Message:class{constructor(value){Object.assign(this,value)}}}});
 bus.emit('error',Error('disconnected'));bus.emit('error',Error('late socket error'));close();
 assert.equal(changes,1);assert.equal(disconnects,1);
});
test('display monitor socket EOF invalidates cached capabilities without an error event',()=>{
 const {EventEmitter}=require('node:events'),{watchLinuxMonitors}=require('../src/linux-desktop.cjs');
 const bus=new EventEmitter();bus._connection=new EventEmitter();let changes=0,disconnects=0;
 bus.call=async()=>{};bus.disconnect=()=>{disconnects++;bus._connection.emit('end')};
 watchLinuxMonitors(()=>changes++,{env:{WAYLAND_DISPLAY:'wayland-0'},dbus:{sessionBus:()=>bus,Message:class{constructor(value){Object.assign(this,value)}}}});
 bus._connection.emit('end');assert.equal(changes,1);assert.equal(disconnects,1);
});
