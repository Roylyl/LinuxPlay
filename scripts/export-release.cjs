// SPDX-License-Identifier: GPL-3.0-or-later
// Export only finished installers and the matching release notes to the desktop.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');

function desktopDirectory(){
 const home=os.homedir();
 let directory;
 try{directory=execFileSync('xdg-user-dir',['DESKTOP'],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']}).trim()}catch{}
 if(!directory){
  try{
   const config=fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME||path.join(home,'.config'),'user-dirs.dirs'),'utf8');
   const saved=/^XDG_DESKTOP_DIR="((?:\\.|[^"\\])*)"\s*$/m.exec(config)?.[1];
   if(saved)directory=saved.replace(/\\([\\"$`])/g,'$1').replace(/\$\{HOME\}|\$HOME(?=\/|$)/g,()=>home);
  }catch{}
 }
 if(!directory)directory=fs.existsSync(path.join(home,'桌面'))?path.join(home,'桌面'):path.join(home,'Desktop');
 if(!path.isAbsolute(directory)||path.resolve(directory)===path.resolve(home))throw Error('当前用户未启用桌面目录，请先配置XDG桌面目录后导出');
 return directory;
}

function exportRelease({artifactPaths,root=path.resolve(__dirname,'..'),desktop=desktopDirectory()}={}){
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 const prefix=`${pkg.build.productName}-${pkg.version}-`;
 const candidates=artifactPaths||fs.readdirSync(path.join(root,'dist')).map(name=>path.join(root,'dist',name));
 const installers=[...new Set(candidates.map(file=>path.resolve(root,file)))].filter(file=>path.basename(file).startsWith(prefix)&&/\.(AppImage|deb)$/.test(file)&&fs.statSync(file).isFile());
 if(!installers.length)throw Error(`未找到${pkg.build.productName}${pkg.version}的AppImage或deb安装包，请先完成打包`);
 const source=path.join(root,'docs',`RELEASE-${pkg.version}.md`);
 if(!fs.existsSync(source))throw Error(`缺少本版更新说明：docs/RELEASE-${pkg.version}.md，请补充后重新导出`);
 const notes=fs.readFileSync(source,'utf8');
 fs.mkdirSync(desktop,{recursive:true});
 const files=[];
 for(const file of installers){
  const target=path.join(desktop,path.basename(file));
  if(path.resolve(file)!==path.resolve(target))fs.copyFileSync(file,target);
  fs.chmodSync(target,fs.statSync(file).mode&0o777);
  files.push(target);
 }
 const releaseNotes=path.join(desktop,`${pkg.build.productName}-${pkg.version}-更新说明.md`);
 fs.writeFileSync(releaseNotes,notes,'utf8');
 files.push(releaseNotes);
 for(const file of files)console.log(`已导出到桌面：${file}`);
 return {desktop,files};
}

// electron-builder's afterAllArtifactBuild hook. Directory-only builds do not
// produce installers and therefore have nothing to export.
module.exports=async result=>{
 if(result.artifactPaths.some(file=>/\.(AppImage|deb)$/.test(file)))exportRelease({artifactPaths:result.artifactPaths});
 return [];
};
module.exports.exportRelease=exportRelease;
module.exports.desktopDirectory=desktopDirectory;
if(require.main===module){
 try{exportRelease()}catch(error){console.error('桌面导出失败：'+error.message);process.exitCode=1}
}
