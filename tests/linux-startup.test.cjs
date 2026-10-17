const test=require('node:test'),assert=require('node:assert/strict');
const {ensureLinuxDisplayBackend}=require('../src/linux-startup.cjs');
function mockApp(){const calls=[];return {calls,relaunch:options=>calls.push(['relaunch',options]),exit:code=>calls.push(['exit',code])}}
test('Linux X11 relaunch preserves arguments and exits after scheduling the restart',()=>{
 const app=mockApp(),argv=['/opt/LinuxPlay/linuxplay','/path with spaces/app','--self-test','--ozone-platform-hint=auto'];
 assert.equal(ensureLinuxDisplayBackend(app,{platform:'linux',env:{DISPLAY:':0'},argv,execPath:argv[0]}),true);
 assert.deepEqual(app.calls,[['relaunch',{execPath:argv[0],args:[...argv.slice(1),'--ozone-platform=x11']}],['exit',0]]);
 assert.deepEqual(argv,['/opt/LinuxPlay/linuxplay','/path with spaces/app','--self-test','--ozone-platform-hint=auto']);
});
test('the restarted process does not relaunch again',()=>{
 const first=mockApp(),options={platform:'linux',env:{DISPLAY:':0'},argv:['/opt/LinuxPlay/linuxplay','--example'],execPath:'/opt/LinuxPlay/linuxplay'};
 ensureLinuxDisplayBackend(first,options);
 const restart=first.calls[0][1],second=mockApp();
 assert.equal(ensureLinuxDisplayBackend(second,{...options,argv:[restart.execPath,...restart.args]}),false);
 assert.deepEqual(second.calls,[]);
});
test('AppImage relaunch uses the original executable instead of its temporary mount',()=>{
 const app=mockApp(),image='/home/user/Applications/LinuxPlay 1.0.AppImage';
 assert.equal(ensureLinuxDisplayBackend(app,{platform:'linux',env:{DISPLAY:':1',APPIMAGE:image},argv:['/tmp/.mount_LinuxPlay/linuxplay','--example'],execPath:'/tmp/.mount_LinuxPlay/linuxplay'}),true);
 assert.deepEqual(app.calls[0],['relaunch',{execPath:image,args:['--example','--ozone-platform=x11']}]);
});
test('AppImage relaunch preserves extraction mode after its runtime consumes the CLI flag',()=>{
 const image='/home/user/Applications/LinuxPlay 1.0.AppImage';
 for(const extraction of [{APPDIR:'/tmp/appimage_extracted_fixture'},{APPDIR:'/custom temp/appimage_extracted_fixture/'},{APPIMAGE_EXTRACT_AND_RUN:'1'}]){
  const app=mockApp();
  assert.equal(ensureLinuxDisplayBackend(app,{platform:'linux',env:{DISPLAY:':1',APPIMAGE:image,...extraction},argv:['/tmp/appimage_extracted_fixture/linuxplay','--example'],execPath:'/tmp/appimage_extracted_fixture/linuxplay'}),true);
  assert.deepEqual(app.calls[0],['relaunch',{execPath:image,args:['--appimage-extract-and-run','--example','--ozone-platform=x11']}]);
  const restart=app.calls[0][1],second=mockApp();
  assert.equal(ensureLinuxDisplayBackend(second,{platform:'linux',env:{DISPLAY:':1',APPIMAGE:image,...extraction},argv:[image,...restart.args],execPath:image}),false);
  assert.deepEqual(second.calls,[]);
 }
});
test('extraction mode is neither duplicated nor added to an unpacked executable',()=>{
 const common={platform:'linux',env:{DISPLAY:':1',APPIMAGE:'/app.AppImage',APPDIR:'/tmp/appimage_extracted_fixture'},execPath:'/tmp/appimage_extracted_fixture/linuxplay'};
 const app=mockApp();
 ensureLinuxDisplayBackend(app,{...common,argv:[common.execPath,'--appimage-extract-and-run','--example']});
 assert.deepEqual(app.calls[0][1].args,['--appimage-extract-and-run','--example','--ozone-platform=x11']);
 const unpacked=mockApp();
 ensureLinuxDisplayBackend(unpacked,{...common,env:{DISPLAY:':1',APPDIR:common.env.APPDIR},argv:[common.execPath,'--example']});
 assert.deepEqual(unpacked.calls[0][1].args,['--example','--ozone-platform=x11']);
});
test('other platforms, missing X11 displays, and explicit backend choices stay unchanged',()=>{
 const base={platform:'linux',env:{DISPLAY:':0'},argv:['linuxplay'],execPath:'/opt/LinuxPlay/linuxplay'};
 const cases=[
  {platform:'win32'},
  {platform:'darwin'},
  {env:{}},
  {env:{DISPLAY:'',WAYLAND_DISPLAY:'wayland-0'}},
  {argv:['linuxplay','--ozone-platform=x11']},
  {argv:['linuxplay','--ozone-platform=wayland']},
  {argv:['linuxplay','--ozone-platform','x11']},
  {argv:['linuxplay','--ozone-platform','wayland']}
 ];
 for(const change of cases){const app=mockApp();assert.equal(ensureLinuxDisplayBackend(app,{...base,...change}),false);assert.deepEqual(app.calls,[])}
});
