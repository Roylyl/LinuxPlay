function ensureLinuxDisplayBackend(app,{platform=process.platform,env=process.env,argv=process.argv,execPath=process.execPath}={}){
 if(platform!=='linux'||!env.DISPLAY||argv.some(arg=>arg==='--ozone-platform'||arg.startsWith('--ozone-platform=')))return false;
 // Ozone chooses the display backend before the main script runs.
 // Restart the AppImage itself so its temporary mount may be recreated.
 const args=[...argv.slice(1),'--ozone-platform=x11'];
 // The AppImage runtime consumes --appimage-extract-and-run before Electron
 // starts. Preserve that mode when restarting on systems without FUSE.
 const extractedImage=env.APPIMAGE&&(env.APPIMAGE_EXTRACT_AND_RUN||/(?:^|\/)appimage_extracted_[^/]+\/?$/.test(env.APPDIR||''));
 if(extractedImage&&!args.includes('--appimage-extract-and-run'))args.unshift('--appimage-extract-and-run');
 app.relaunch({execPath:env.APPIMAGE||execPath,args});
 app.exit(0);
 return true;
}
module.exports={ensureLinuxDisplayBackend};
