// SPDX-License-Identifier: GPL-3.0-or-later
// Read-only prerequisite diagnostics. Never reads Wi-Fi secrets or authentication.
const {spawnSync}=require('node:child_process');
let missing=0;
function report(ok,name,detail,required=true){console.log(`${ok?'[OK]':required?'[缺少]':'[提示]'} ${name}：${detail}`);if(!ok&&required)missing++;}
function run(command,args){return spawnSync(command,args,{encoding:'utf8',timeout:5000,env:{...process.env,LC_ALL:'C'}});}

report(process.platform==='linux','运行平台',process.platform);
const python=run('python3',['-c','import socket,sys; assert hasattr(socket,"AF_BLUETOOTH") and hasattr(socket,"BTPROTO_RFCOMM"); print(sys.version.split()[0])']);
report(!python.error&&python.status===0,'Python3蓝牙socket',python.status===0?python.stdout.trim():'需要Python3及AF_BLUETOOTH/BTPROTO_RFCOMM支持');
for(const [command,args,name]of [['bluetoothctl',['--version'],'BlueZ蓝牙工具'],['nmcli',['--version'],'NetworkManager']]){
 const result=run(command,args);report(!result.error&&result.status===0,name,result.status===0?result.stdout.trim():`请安装${command==='nmcli'?'network-manager':'bluez'}`);
}
const bluetooth=run('bluetoothctl',['list']);
report(!bluetooth.error&&bluetooth.status===0&&/Controller\s/.test(bluetooth.stdout),'蓝牙适配器','开启BlueZ服务和蓝牙后应至少存在一个Controller',false);
report(!!process.env.DISPLAY,'X11/XWayland会话',process.env.DISPLAY?'DISPLAY已设置':'完整窗口、定位与严格物理像素功能需要X11/XWayland',false);
report(!!process.env.DBUS_SESSION_BUS_ADDRESS,'会话D-Bus','系统媒体控件需要用户桌面会话D-Bus',false);
const xrandr=run('xrandr',['--version']);
report(!xrandr.error&&xrandr.status===0,'xrandr显示信息','严格物理像素模式需要xrandr；Debian/Ubuntu可安装x11-xserver-utils');
if(missing){console.error(`缺少${missing}项必需组件，请按README安装后重试。`);process.exitCode=1;}
else console.log('必需工具已就绪。请在系统蓝牙设置中配对iPhone，并准备热点或共用局域网。');
