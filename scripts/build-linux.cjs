// SPDX-License-Identifier: GPL-3.0-or-later
// Reuse the host's standalone Node runtime and package the Python bridge.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

if(process.platform!=='linux')throw new Error('请在Linux上构建LinuxPlay');
if(process.versions.electron)throw new Error('请使用独立Node.js24构建，Electron的加密库不能运行CarPlay接收引擎');
if(Number(process.versions.node.split('.')[0])!==24)throw new Error('构建需要Node.js24，安装包将复用当前Node运行时');
const root=path.resolve(__dirname,'..');
const runtimeDirectory=path.join(root,'resources','node');
fs.mkdirSync(runtimeDirectory,{recursive:true});
const runtime=path.join(runtimeDirectory,'node');
if(fs.realpathSync(process.execPath)!==runtime)fs.copyFileSync(process.execPath,runtime);
fs.chmodSync(runtime,0o755);
const python=spawnSync('python3',['-c','import socket; assert hasattr(socket,"AF_BLUETOOTH") and hasattr(socket,"BTPROTO_RFCOMM"), "Python缺少Linux蓝牙socket支持"'],{encoding:'utf8',timeout:10000});
if(python.error||python.status!==0)throw new Error((python.stderr||python.error?.message||'请安装带蓝牙socket支持的Python3').trim());

const directory=path.join(root,'build','native');
fs.mkdirSync(directory,{recursive:true});
for(const name of ['WinPlay.Platform.exe','WinPlay.Media.exe'])fs.rmSync(path.join(directory,name),{force:true});
const target=path.join(directory,'LinuxPlay.Platform');
fs.copyFileSync(path.join(root,'native','linux-platform.py'),target);
fs.chmodSync(target,0o755);
// Releases include a usable authentication pair, matching the first-run experience.
const authDirectory=path.join(root,'resources','authentication');
const {validateAuthentication}=require('../build/engine/auth.js');
validateAuthentication(fs.readFileSync(path.join(authDirectory,'identity.pk8')),fs.readFileSync(path.join(authDirectory,'certificate.p7b')));
console.log('Linux蓝牙桥接已准备：build/native/LinuxPlay.Platform');
console.log(`独立Node运行时已准备：${process.version}，linux-${process.arch}；请在目标架构构建安装包。`);
