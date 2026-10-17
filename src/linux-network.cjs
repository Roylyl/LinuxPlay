// SPDX-License-Identifier: GPL-3.0-or-later
// NetworkManager and BlueZ supply the same records consumed by the Windows UI.
// Commands are read-only. Secrets stay in memory and never enter diagnostics.
const {execFile}=require('node:child_process');

const NM=['--colors','no','--terse','--escape','yes'];
const DEVICE_FIELDS='GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,GENERAL.CON-UUID,GENERAL.IS-SOFTWARE,GENERAL.PRODUCT,IP4.GATEWAY,IP4.ROUTE,IP6.GATEWAY,IP6.ROUTE';
const PROFILE_FIELDS='connection.id,connection.uuid,connection.interface-name,connection.timestamp,802-11-wireless.ssid,802-11-wireless.mode,802-11-wireless.channel,ipv4.method';
const MAC=/^[\da-f]{2}(?::[\da-f]{2}){5}$/i;
const uuidPattern=/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
function splitEscaped(line){
 const values=[''];let escaped=false;
 for(const character of line){if(escaped){values[values.length-1]+=character;escaped=false}else if(character==='\\')escaped=true;else if(character===':')values.push('');else values[values.length-1]+=character}
 if(escaped)values[values.length-1]+='\\';return values;
}
function properties(output){
 const result={};
 for(const line of String(output).replace(/\r\n/g,'\n').split('\n')){
  const at=line.indexOf(':');if(at<0)continue;
  const name=line.slice(0,at),value=line.slice(at+1);result[name]=value;
 }
 return result;
}
function parseDevices(output){
 return String(output).split(/\r?\n\r?\n/).map(properties).filter(value=>value['GENERAL.DEVICE']).map(value=>{
  const routes=Object.entries(value).filter(([key])=>/^IP[46]\.ROUTE/.test(key)).map(([,route])=>route);
  const defaults=routes.filter(route=>/\bdst = (?:0\.0\.0\.0\/0|::\/0)(?:,|$)/.test(route));
  const metrics=defaults.map(route=>Number(route.match(/\bmt = (\d+)/)?.[1])).filter(Number.isFinite);
  const type=value['GENERAL.TYPE'],state=Number.parseInt(value['GENERAL.STATE'],10);
  return {name:value['GENERAL.DEVICE'],description:value['GENERAL.PRODUCT']||type,guid:value['GENERAL.CON-UUID']||'',up:state===100,wireless:type==='wifi',physical:['wifi','ethernet'].includes(type)&&value['GENERAL.IS-SOFTWARE']!=='yes',lanCandidate:['wifi','ethernet'].includes(type),defaultRoute:defaults.length>0,routeMetric:metrics.length?Math.min(...metrics):undefined,state,type};
 });
}
function parseProfiles(output){
 return String(output).split(/\r?\n/).filter(Boolean).map(splitEscaped).map(([uuid,type,active,device])=>({uuid,type,active:active==='yes',device})).filter(profile=>uuidPattern.test(profile.uuid)&&['802-11-wireless','wifi'].includes(profile.type));
}
function parseProfile(output,profile={}){
 const value=properties(output);
 return {...profile,id:value['connection.id']||'',uuid:value['connection.uuid']||profile.uuid,interfaceName:profile.device||value['connection.interface-name']||'',timestamp:Number(value['connection.timestamp'])||0,ssid:value['802-11-wireless.ssid'],mode:value['802-11-wireless.mode'],channel:Number(value['802-11-wireless.channel'])||0,method:value['ipv4.method']};
}
function commandFailure(file,error,output,signal){
 const dependency=file==='nmcli'?'NetworkManager':'BlueZ';
 const code=signal?.aborted?'CANCELLED':error?.code==='ENOENT'?'DEPENDENCY_MISSING':error?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'OUTPUT_LIMIT':error?.killed?'TIMEOUT':'QUERY_FAILED';
 const text=String(output||'');
 const message=code==='CANCELLED'?'网络检查已取消':code==='DEPENDENCY_MISSING'?`缺少${file}，请安装${dependency}并启动对应系统服务`:code==='TIMEOUT'?`${dependency}查询超时，请确认系统服务正常运行后重试`:/not running|not provided by any|Failed to connect|Failed to init|org\.freedesktop\.DBus\.Error\.ServiceUnknown/i.test(text)?`${dependency}服务不可用，请启动${file==='nmcli'?'NetworkManager':'bluetooth'}服务后重试`:/not authorized|permission denied|access denied|not permitted|NotAuthorized/i.test(text)?`系统拒绝读取${dependency}信息，请在当前桌面会话授予网络或蓝牙访问权限后重试`:`无法读取${dependency}信息，请检查系统网络或蓝牙服务后重试`;
 return {ok:false,code,error:message};
}
function createLinuxNetwork({execute=execFile,now=Date.now}={}){
 function run(file,args,{timeoutMs=8000,signal}={}){
  return new Promise(resolve=>{
   if(signal?.aborted){resolve(commandFailure(file,{code:'ABORT_ERR'},'',signal));return}
   execute(file,args,{timeout:Math.max(1,timeoutMs),maxBuffer:1024*1024,encoding:'utf8',signal,env:{...process.env,LC_ALL:'C.UTF-8',LANG:'C.UTF-8',CLICOLOR_FORCE:'',NO_COLOR:'1'}},(error,out='',stderr='')=>{
    if(error)resolve(commandFailure(file,error,stderr||out,signal));else resolve({ok:true,output:String(out)});
   });
  });
 }
 function request(options={}){
  const deadline=now()+Math.max(1,options.timeoutMs??8000);
  return (file,args)=>run(file,args,{signal:options.signal,timeoutMs:Math.max(1,deadline-now())});
 }
 async function profileList(query,active=false){
  const result=await query('nmcli',[...NM,'--fields','UUID,TYPE,ACTIVE,DEVICE','connection','show',...(active?['--active']:[])]);
  return result.ok?{ok:true,profiles:parseProfiles(result.output)}:result;
 }
 async function profileDetails(query,profile){
  const result=await query('nmcli',[...NM,'--mode','multiline','--fields',PROFILE_FIELDS,'connection','show','uuid',profile.uuid]);
  return result.ok?{ok:true,profile:parseProfile(result.output,profile)}:result;
 }
 async function password(query,profile){
  const result=await query('nmcli',[...NM,'--show-secrets','--mode','multiline','--fields','802-11-wireless-security.key-mgmt,802-11-wireless-security.psk','connection','show','uuid',profile.uuid]);
  if(!result.ok)return result;
  const values=properties(result.output),kind=values['802-11-wireless-security.key-mgmt'],value=values['802-11-wireless-security.psk'];
  if(!['wpa-psk','sae'].includes(kind)||!value||value==='--'||value.includes('\0'))return {ok:false,code:'PASSWORD_UNAVAILABLE',error:'该网络没有可读取的已保存共享密码，请在系统网络设置中核对后手动填写'};
  return {ok:true,password:value};
 }
 async function readLinuxNetworkMetadata(options={}){
  const started=now(),query=request(options);
  const devices=await query('nmcli',[...NM,'--mode','multiline','--fields',DEVICE_FIELDS,'device','show']);
  const base={platform:'linux',privateNames:[],publicNames:[],sharingAvailable:false,tetheringStates:[],tetheringFailures:0};
  if(!devices.ok)return {...base,queryFailed:true,error:devices.error,sharingError:devices.code,tetheringError:devices.code,queries:[{stage:'adapters',code:devices.code,elapsedMs:now()-started,records:0}]};
  const adapters=parseDevices(devices.output),metadata={...base,adapters,queryFailed:adapters.length===0,queries:[{stage:'adapters',code:adapters.length?'OK':'INVALID_OUTPUT',source:'networkmanager',elapsedMs:now()-started,records:adapters.length}]};
  if(options.mode==='lan'){
   // Linux AP mode uses the physical Wi-Fi adapter itself, unlike Windows'
   // separately identifiable Wi-Fi Direct interface. Classify only connected
   // wireless adapters here so a hotspot cannot masquerade as a LAN client.
   const wireless=adapters.filter(adapter=>adapter.wireless&&adapter.up);
   await Promise.all(wireless.map(async adapter=>{
    const result=uuidPattern.test(adapter.guid)?await profileDetails(query,{uuid:adapter.guid,device:adapter.name}):{ok:false,code:'WIFI_PROFILE_UNAVAILABLE'};
    adapter.lanCandidate=result.ok&&result.profile.mode==='infrastructure';
    metadata.queries.push({stage:'wireless-mode',code:result.ok?'OK':result.code,records:result.ok?1:0});
   }));
   return metadata;
  }
  const list=await profileList(query,true);
  if(!list.ok)return {...metadata,sharingError:list.code,tetheringError:list.code,tetheringFailures:1,error:list.error,queries:[...metadata.queries,{stage:'tethering',code:list.code,records:0}]};
  const details=await Promise.all(list.profiles.map(profile=>profileDetails(query,profile)));
  const failures=details.filter(result=>!result.ok),hotspots=details.filter(result=>result.ok&&result.profile.mode==='ap'&&result.profile.method==='shared').map(result=>result.profile);
  metadata.privateNames=hotspots.map(profile=>profile.interfaceName).filter(Boolean);
  metadata.publicNames=adapters.filter(adapter=>adapter.defaultRoute&&!metadata.privateNames.includes(adapter.name)).map(adapter=>adapter.name);
  metadata.sharingAvailable=failures.length===0;
  metadata.tetheringStates=hotspots.length?['On']:adapters.some(adapter=>adapter.wireless&&adapter.state>=40&&adapter.state<100)?['InTransition']:failures.length?['Unknown']:['Off'];
  metadata.tetheringFailures=failures.length;
  if(failures.length){metadata.tetheringError=failures[0].code;metadata.sharingError=failures[0].code;metadata.error=failures[0].error}
  metadata.queries.push({stage:'tethering',code:failures.length?failures[0].code:'OK',records:details.length,elapsedMs:now()-started},{stage:'sharing',code:failures.length?failures[0].code:'OK',records:hotspots.length});
  return metadata;
 }
 async function readLinuxHotspotConfiguration(options={}){
  const query=request(options),list=await profileList(query);
  if(!list.ok)return list;
  const details=await Promise.all(list.profiles.map(profile=>profileDetails(query,profile)));
  const activeFailure=details.find((result,index)=>list.profiles[index].active&&!result.ok);
  if(activeFailure)return activeFailure;
  const profiles=details.filter(result=>result.ok&&result.profile.mode==='ap'&&result.profile.method==='shared').map(result=>result.profile);
  const active=profiles.filter(profile=>profile.active);
  if(active.length>1)return {ok:false,code:'HOTSPOT_AMBIGUOUS',error:'检测到多个正在运行的热点，请在系统网络设置中仅保留要使用的热点后重试'};
  const profile=active[0]||profiles.sort((a,b)=>b.timestamp-a.timestamp)[0];
  if(!profile)return {ok:false,code:'HOTSPOT_CONFIGURATION_UNAVAILABLE',error:'未找到NetworkManager热点配置，请先在系统网络设置中创建Wi-Fi热点后重试'};
  if(typeof profile.ssid!=='string'||!profile.ssid||profile.ssid.includes('\0')||Buffer.byteLength(profile.ssid)>32)return {ok:false,code:'HOTSPOT_CONFIGURATION_INVALID',error:'系统热点名称无效，请在系统网络设置中重新保存热点配置'};
  const saved=await password(query,profile);
  return {ok:true,ssid:profile.ssid,state:profile.active?'On':'Off',channel:profile.channel,interfaceName:profile.interfaceName,...(saved.ok?{password:saved.password}:{passwordError:saved.error,passwordCode:saved.code})};
 }
 async function readLinuxWlan(op,ssid,options={}){
  if(!['read-network','read-password'].includes(op))throw Error('无线读取操作无效');
  if(op==='read-password'&&(typeof ssid!=='string'||!ssid.trim()||Buffer.byteLength(ssid)>32||ssid.includes('\0')))throw Error('请先填写有效SSID');
  const query=request(options);
  const list=await profileList(query,true);if(!list.ok)return list;
  const selected=list.profiles.filter(profile=>!options.interfaceName||profile.device===options.interfaceName);
  const details=await Promise.all(selected.map(profile=>profileDetails(query,profile)));
  const profiles=details.filter(result=>result.ok&&result.profile.mode!=='ap'&&result.profile.mode!=='mesh'&&result.profile.mode!=='adhoc').map(result=>result.profile);
  const profile=profiles.find(profile=>(op!=='read-password'||profile.ssid===ssid)&&(!options.profileName||profile.uuid===options.profileName||profile.id===options.profileName));
  if(!profile){const failure=details.find(result=>!result.ok);return failure||{ok:false,code:'WIFI_NOT_CONNECTED',error:'未检测到所选网卡上已连接的Wi-Fi，请先连接无线网络后重试'}};
  if(op==='read-password')return password(query,profile);
  if(!profile.ssid||Buffer.byteLength(profile.ssid)>32||profile.ssid.includes('\0'))return {ok:false,code:'WIFI_INFORMATION_INVALID',error:'无法读取当前Wi-Fi名称，请在系统网络设置中核对后手动填写'};
  const accessPoints=await query('nmcli',[...NM,'--fields','IN-USE,SSID,CHAN,BSSID','device','wifi','list','ifname',profile.interfaceName,'--rescan','no']);
  const accessPoint=accessPoints.ok?accessPoints.output.split(/\r?\n/).filter(Boolean).map(splitEscaped).find(([used,network])=>used==='*'&&network===profile.ssid):undefined;
  const channel=Number(accessPoint?.[2])||profile.channel;
  return {ok:true,ssid:profile.ssid,interfaceName:profile.interfaceName,profileName:profile.uuid,channel,...(MAC.test(accessPoint?.[3]||'')?{bssid:accessPoint[3].toUpperCase()}:{}),...(!accessPoints.ok?{warning:'当前Wi-Fi已读取，但无法读取接入点信道和BSSID'}:{})};
 }
 async function listBluetoothDevices(options={}){
  const query=request({...options,timeoutMs:options.timeoutMs??12000}),clean=value=>String(value).replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
  const controller=await query('bluetoothctl',['--timeout','5','show']);
  if(!controller.ok)return controller;
  const info=clean(controller.output),adapter=info.match(/^Controller ([\da-f:]{17})(?:\s|$)/mi)?.[1];
  if(!adapter||!MAC.test(adapter))return {ok:false,code:'BLUETOOTH_ADAPTER_UNAVAILABLE',error:'未检测到可用蓝牙适配器，请连接蓝牙适配器、启动bluetooth服务并解除rfkill屏蔽后重试'};
  if(!/^\s*Powered:\s*yes\s*$/mi.test(info))return {ok:false,code:'BLUETOOTH_POWERED_OFF',error:'蓝牙适配器尚未开启，请在系统蓝牙设置中开启蓝牙后重试'};
  let result=await query('bluetoothctl',['--timeout','5','devices','Paired']);
  if(!result.ok)return result;
  if(/Invalid command|Unknown command|Invalid argument/i.test(result.output))result=await query('bluetoothctl',['--timeout','5','paired-devices']);
  if(!result.ok)return result;
  if(/Invalid command|Unknown command|Invalid argument|Failed|not available|org\.bluez\.Error/i.test(result.output))return {ok:false,code:'BLUETOOTH_QUERY_FAILED',error:'无法读取已配对蓝牙设备，请确认BlueZ服务正常运行并在系统蓝牙设置中完成iPhone配对后重试'};
  const devices=clean(result.output).split(/\r?\n/).flatMap(line=>{const match=line.match(/^Device ([\da-f:]{17}) (.+)$/i);return match&&MAC.test(match[1])?[{name:match[2],address:match[1].toUpperCase()}]:[]});
  return {ok:true,adapter:adapter.toUpperCase(),devices};
 }
 return {readLinuxNetworkMetadata,readLinuxHotspotConfiguration,readLinuxWlan,listBluetoothDevices};
}
module.exports={createLinuxNetwork,splitEscaped,parseDevices,parseProfiles,parseProfile,...createLinuxNetwork()};
