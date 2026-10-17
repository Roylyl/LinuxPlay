const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../src/main.cjs'),'utf8');
function fixture({strict=true,acceptedSize,resizeError=false,verified=true}={}){
 const events=[],calls=[],logs=[];let bounds={x:80,y:60,width:800,height:630};
 const displays=[{id:1,scaleFactor:2,bounds:{x:0,y:0,width:1920,height:1200},workArea:{x:0,y:0,width:1920,height:1170}},{id:2,scaleFactor:1,bounds:{x:1920,y:0,width:1920,height:1080},workArea:{x:1920,y:0,width:1920,height:1050}}];
 const win={videoAspectRatio:16/9,isDestroyed:()=>false,isMinimized:()=>false,
  getBounds:()=>({...bounds}),getContentSize:()=>[bounds.width,bounds.height-30],
  setResizable(value){calls.push(['resizable',value])},
  setContentSize(width,height){calls.push(['content',width,height]);if(resizeError)throw Error('WM rejected resize');const size=acceptedSize||[width,height];bounds={...bounds,width:size[0],height:size[1]+30}},
  setBounds(value){bounds={...value};calls.push(['bounds',value])},
  setPosition(x,y){bounds={...bounds,x,y};calls.push(['position',x,y])},
  show(){calls.push(['show'])},focus(){calls.push(['focus'])},webContents:{send:(_type,event)=>events.push(event)}
 };
 const context={linux:true,video:win,videoDisplayId:1,videoPixelSize:{width:1280,height:720,strictPixels:strict,fullScreen:false},videoSized:true,
  selfTest:false,videoDecoded:true,videoHidden:false,display:displays[0],verified,stops:0,
  linuxContentSize:require('../src/linux-desktop.cjs').linuxContentSize,
  screen:{getDisplayMatching:()=>context.display},displayPixels:d=>({verified:context.verified,pixelScale:d.id===1?4/3:1}),
  log:(...args)=>logs.push(args),stop(){context.stops++}
 };
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function setVideoPixels('),source.indexOf('// Apply one client-area ratio constraint')),context);
 return {context,win,displays,events,calls,logs};
}
test('strict Linux window follows the actual physical scale when moved across displays',()=>{
 const h=fixture();h.context.setVideoPixels();assert.equal(h.context.stops,0);
 assert.deepEqual(h.win.getContentSize(),[960,540]);assert.equal(h.events.at(-1).pixelScale,4/3);
 const positions=h.calls.filter(c=>c[0]==='position').length;
 h.context.display=h.displays[1];h.context.updateLinuxVideoDisplay(h.win);
 assert.deepEqual(h.win.getContentSize(),[1280,720]);assert.equal(h.events.at(-1).pixelScale,1);assert.equal(h.context.videoDisplayId,2);
 assert.equal(h.calls.filter(c=>c[0]==='position').length,positions);
 const count=h.calls.length;h.context.updateLinuxVideoDisplay(h.win);assert.equal(h.calls.length,count);
});
test('strict window cannot keep running with estimated pixels after moving to an unverified display',()=>{
 const h=fixture();h.context.setVideoPixels();const count=h.events.length;
 h.context.display=h.displays[1];h.context.verified=false;h.context.updateLinuxVideoDisplay(h.win);
 assert.equal(h.context.stops,1);assert.equal(h.context.videoSized,false);assert.equal(h.events.length,count);
});
for(const [name,size] of [['smaller',[959,540]],['larger',[1000,560]]])test('strict mode rejects a '+name+' physical client area',()=>{
 const h=fixture({acceptedSize:size});h.context.setVideoPixels();assert.equal(h.context.stops,1);assert.equal(h.events.length,0);
});
test('strict sizing accepts only bounded rounding padding like WinPlay',()=>{
 const h=fixture({acceptedSize:[961,541]});h.context.setVideoPixels();assert.equal(h.context.stops,0);assert.equal(h.events.at(-1).width,1280);assert.equal(h.events.at(-1).height,720);
});
test('ordinary fit retains playback when the window manager rejects the requested size',()=>{
 const h=fixture({strict:false,resizeError:true,verified:false});h.context.setVideoPixels();
 assert.equal(h.context.stops,0);assert.equal(h.context.videoSized,true);assert.equal(h.events.at(-1).strictPixels,false);
 assert.deepEqual(h.win.getContentSize(),[800,450]);assert.ok(h.calls.some(c=>c[0]==='show'));
});
test('ordinary fit moving displays preserves its logical window size and updates the viewport scale',()=>{
 const h=fixture({strict:false});h.context.setVideoPixels();const before=h.win.getContentSize(),count=h.calls.length;
 h.context.display=h.displays[1];h.context.updateLinuxVideoDisplay(h.win);
 assert.deepEqual(h.win.getContentSize(),before);assert.equal(h.calls.length,count);assert.equal(h.events.at(-1).pixelScale,1);
 assert.equal(h.events.at(-1).width,before[0]);
});
