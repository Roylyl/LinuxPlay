import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
export const dataDir = process.env.WINPLAY_DATA || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'LinuxPlay', 'data')
export const app = { getPath: (_: string) => dataDir }
function protect(data: Buffer, decrypt = false): Buffer {
 if(process.platform==='linux'){
  const key=Buffer.from(process.env.LINUXPLAY_STORAGE_KEY||'', 'base64')
  if(key.length!==32)throw new Error('接收端凭据密钥不可用，请通过LinuxPlay启动接收')
  if(decrypt){
   if(data.length<32||data.subarray(0,4).toString()!=='LP01')throw new Error('凭据格式无效，请在LinuxPlay中重新导入认证文件')
   const cipher=createDecipheriv('aes-256-gcm',key,data.subarray(4,16));cipher.setAuthTag(data.subarray(16,32))
   return Buffer.concat([cipher.update(data.subarray(32)),cipher.final()])
  }
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv)
  const encrypted=Buffer.concat([cipher.update(data),cipher.final()])
  return Buffer.concat([Buffer.from('LP01'),iv,cipher.getAuthTag(),encrypted])
 }
 const helper = process.env.WINPLAY_NATIVE!
 return execFileSync(helper, [decrypt ? 'unprotect' : 'protect'], {input:data, windowsHide:true, maxBuffer:16*1024*1024})
}
export function readProtected(file: string): Buffer { return protect(readFileSync(file),true) }
export function writeProtected(file: string, bytes: Buffer): void {
 mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file+'.new',protect(bytes),{mode:0o600});renameSync(file+'.new',file)
}
export function writeFileAtomic(file: string, text: string, _mode=0o600): void {writeProtected(file,Buffer.from(text))}
