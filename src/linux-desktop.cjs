const fs=require('node:fs'),path=require('node:path');
const {execFile,spawn}=require('node:child_process');
function parseMonitors(text){
 const items=[];let output;
 for(const line of String(text).split('\n')){
  const m=/^(\S+) connected (primary )?(\d+)x(\d+)([+-]\d+)([+-]\d+)(?: (left|right|inverted))?/.exec(line);
  if(/^\S/.test(line))output=m?{label:m[1],primary:!!m[2],width:Number(m[3]),height:Number(m[4]),x:Number(m[5]),y:Number(m[6]),rotated:m[7]==='left'||m[7]==='right'}:undefined;
  const mode=/^\s+(\d+)x(\d+)(?:\S*)\s+.*\*/.exec(line);
  if(output&&mode){
   const width=Number(mode[output.rotated?2:1]),height=Number(mode[output.rotated?1:2]);
   // The header is the desktop rectangle, which xrandr --scale can enlarge.
   // Only an untransformed current mode certifies physical window pixels.
   if(width===output.width&&height===output.height){const {rotated,...item}=output;items.push(item)}
   output=undefined;
  }
 }
 if(!items.length)throw Error('无法读取X11显示器物理像素，请确认XWayland或X11正在运行');
 return items;
}
function parseMutterState(body){
 const [,physical,logical]=body,items=[];
 const value=v=>v&&typeof v==='object'&&'value' in v?v.value:v;
 for(const [x,y,scale,transform,primary,specs] of logical){
  for(const spec of specs){
   const monitor=physical.find(m=>m[0].every((v,i)=>v===spec[i]));
   const mode=monitor?.[1].find(m=>value(m[6]?.['is-current'])===true);
   if(!mode||!Number.isFinite(scale)||scale<=0)continue;
   const rotated=transform%2===1,width=mode[rotated?2:1],height=mode[rotated?1:2];
   if(width>0&&height>0)items.push({label:spec[0],x,y,width,height,scaleFactor:scale,refreshRate:mode[3],primary,source:'mutter'});
  }
 }
 if(!items.length)throw Error('桌面未返回当前显示模式');
 return items;
}
async function readMutterMonitors(){
 const dbus=require('dbus-next');
 const address=(process.env.DBUS_SESSION_BUS_ADDRESS||`unix:path=${process.env.XDG_RUNTIME_DIR}/bus`).replace(/unix:path=/g,'unix:socket=');
 const bus=dbus.sessionBus({busAddress:address});let timer;
 try{
  const result=await Promise.race([
   bus.call(new dbus.Message({destination:'org.gnome.Mutter.DisplayConfig',path:'/org/gnome/Mutter/DisplayConfig',interface:'org.gnome.Mutter.DisplayConfig',member:'GetCurrentState'})),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('显示配置读取超时')),3000);bus.once('error',reject)})
  ]);
  return parseMutterState(result.body);
 }finally{clearTimeout(timer);bus.disconnect()}
}
async function readLinuxMonitors({execute=execFile,env=process.env,readMutter=readMutterMonitors}={}){
 if(env.XDG_SESSION_TYPE==='wayland'||env.WAYLAND_DISPLAY){
  // RandR on XWayland describes a compositor render target, not panel pixels.
  // Never certify this virtual surface as a physical display on failure.
  return readMutter();
 }
 return new Promise((resolve,reject)=>execute('xrandr',['--current'],{timeout:5000,env:{...process.env,LC_ALL:'C'}},(error,out)=>{
  if(error)return reject(Error(error.code==='ENOENT'?'缺少xrandr，请安装x11-xserver-utils或xorg-xrandr':'无法查询X11显示器，请检查DISPLAY和XWayland'));
  try{resolve(parseMonitors(out))}catch(error){reject(error)}
 }));
}
function watchLinuxMonitors(onChange,{env=process.env,dbus}={}){
 if(env.XDG_SESSION_TYPE!=='wayland'&&!env.WAYLAND_DISPLAY)return ()=>{};
 dbus=dbus||require('dbus-next');
 const address=(env.DBUS_SESSION_BUS_ADDRESS||`unix:path=${env.XDG_RUNTIME_DIR}/bus`).replace(/unix:path=/g,'unix:socket=');
 let bus,closed=false;
 const close=()=>{if(closed)return;closed=true;bus?.disconnect()};
 const failed=()=>{if(closed)return;close();onChange()};
 try{
  bus=dbus.sessionBus({busAddress:address});bus.on('error',failed);bus._connection?.once('end',failed);
  bus.on('message',message=>{if(!closed&&message.type===4&&message.path==='/org/gnome/Mutter/DisplayConfig'&&message.interface==='org.gnome.Mutter.DisplayConfig'&&message.member==='MonitorsChanged')onChange()});
  bus.call(new dbus.Message({destination:'org.freedesktop.DBus',path:'/org/freedesktop/DBus',interface:'org.freedesktop.DBus',member:'AddMatch',signature:'s',body:["type='signal',sender='org.gnome.Mutter.DisplayConfig',path='/org/gnome/Mutter/DisplayConfig',interface='org.gnome.Mutter.DisplayConfig',member='MonitorsChanged'"]})).catch(failed);
 }catch{failed()}
 return close;
}
function linuxPhysicalDisplay(display,monitors){
 const scale=display.scaleFactor||1,b=display.bounds;
 const estimate={x:Math.round(b.x*scale),y:Math.round(b.y*scale),width:Math.round(b.width*scale),height:Math.round(b.height*scale)};
 const valid=monitors.filter(m=>['x','y','width','height'].every(key=>Number.isInteger(m[key]))&&m.width>0&&m.height>0);
 const named=valid.find(m=>m.label===display.label);
 // Global DIP origins cannot be multiplied by a per-monitor scale on mixed-DPI desktops.
 // Without an output label, verify dimensions only when RandR agrees with that
 // monitor's own scaled size; window placement still uses Electron's DIP bounds.
 const logicalMatches=valid.filter(m=>m.source==='mutter'&&Math.abs(m.x-b.x)<=2&&Math.abs(m.y-b.y)<=2&&Math.abs(m.width/m.scaleFactor-b.width)<=2&&Math.abs(m.height/m.scaleFactor-b.height)<=2);
 const candidates=logicalMatches.length?logicalMatches:valid.filter(m=>m.source!=='mutter'&&Math.abs(m.width-estimate.width)<=Math.ceil(scale)&&Math.abs(m.height-estimate.height)<=Math.ceil(scale));
 let matching=named||((candidates.length===1||candidates.length>1&&candidates.every(m=>m.width===candidates[0].width&&m.height===candidates[0].height))?candidates[0]:undefined);
 // A label identifies the panel, but cannot certify an anisotropic/stale
 // logical-to-physical mapping. Such dimensions must not enable strict mode.
 if(matching&&(!Number.isFinite(b.width)||b.width<=0||!Number.isFinite(b.height)||b.height<=0||Math.abs(matching.height-b.height*(matching.width/b.width))>2))matching=undefined;
 const physicalScale=matching?.source==='mutter'?matching.width/b.width:scale;
 return {...(matching||estimate),scaleFactor:matching?.scaleFactor||scale,pixelScale:physicalScale,verified:!!matching};
}
function linuxContentSize(requested,scale){
 return [Math.max(1,Math.ceil(requested.width/scale)),Math.max(1,Math.ceil(requested.height/scale))];
}
function openLinuxSettings(kind,{desktop=process.env.XDG_CURRENT_DESKTOP||'',environment=process.env,launch=spawn}={}){
 const bluetooth=kind==='bluetooth',panel=bluetooth?'bluetooth':'network';
 const gnome=['gnome-control-center',[panel]],kde=['systemsettings',[bluetooth?'kcm_bluetooth':'kcm_networkmanagement']];
 const candidates=/KDE/i.test(desktop)?[kde,gnome]:[gnome,kde];
 candidates.push(['cinnamon-settings',[panel]],bluetooth?['blueman-manager',[]]:['nm-connection-editor',[]]);
 for(const [name,args] of candidates){
  const executable=String(environment.PATH||'').split(path.delimiter).map(dir=>path.join(dir,name)).find(file=>{try{fs.accessSync(file,fs.constants.X_OK);return true}catch{return false}});
  if(!executable)continue;
  return new Promise((resolve,reject)=>{const child=launch(executable,args,{detached:true,stdio:'ignore',env:environment});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve({ok:true})})});
 }
 return Promise.reject(Error(bluetooth?'未找到蓝牙设置程序，请安装blueman或使用桌面的蓝牙设置':'未找到网络设置程序，请安装nm-connection-editor或使用桌面的网络设置'));
}
module.exports={parseMutterState,parseMonitors,readLinuxMonitors,watchLinuxMonitors,linuxPhysicalDisplay,linuxContentSize,openLinuxSettings};
