// The engine key is sealed by Electron's OS-backed safeStorage. Only the
// receiver child receives its plaintext value; credentials remain encrypted.
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto');
function engineStorageKey(dataDir,safeStorage){
 const file=path.join(dataDir,'engine-key.encrypted');
 if(!safeStorage.isEncryptionAvailable())throw Error('系统凭据存储不可用，请解锁桌面密钥环后重试');
 if(fs.existsSync(file)){
  const key=safeStorage.decryptString(fs.readFileSync(file));
  if(Buffer.from(key,'base64').length!==32)throw Error('接收端凭据密钥无效，请恢复原桌面密钥环');
  return key;
 }
 const key=randomBytes(32).toString('base64');
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 fs.writeFileSync(file,safeStorage.encryptString(key),{mode:0o600,flag:'wx'});
 return key;
}
module.exports={engineStorageKey};
