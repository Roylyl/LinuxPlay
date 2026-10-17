const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {engineStorageKey}=require('../src/secure-storage.cjs');
test('Linux engine credentials use an OS-sealed key and authenticated encrypted storage',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'linuxplay-storage-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const fake={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('test-sealed:'+value),decryptString:value=>value.toString().slice(12)};
 const key=engineStorageKey(dir,fake);assert.equal(Buffer.from(key,'base64').length,32);assert.equal(engineStorageKey(dir,fake),key);
 assert.throws(()=>engineStorageKey(dir,{isEncryptionAvailable:()=>false}),/密钥环/);
 process.env.LINUXPLAY_STORAGE_KEY=key;
 t.after(()=>delete process.env.LINUXPLAY_STORAGE_KEY);
 const storage=require('../build/engine/storage.js'),file=path.join(dir,'auth','credential.dpapi'),plain=Buffer.from('synthetic authentication credential');
 storage.writeProtected(file,plain);const encrypted=fs.readFileSync(file);
 assert.equal(encrypted.includes(plain),false);assert.deepEqual(storage.readProtected(file),plain);assert.equal(fs.statSync(file).mode&0o777,0o600);
 encrypted[encrypted.length-1]^=1;fs.writeFileSync(file,encrypted);assert.throws(()=>storage.readProtected(file));
 process.env.LINUXPLAY_STORAGE_KEY=crypto.randomBytes(32).toString('base64');assert.throws(()=>storage.readProtected(file));
});
