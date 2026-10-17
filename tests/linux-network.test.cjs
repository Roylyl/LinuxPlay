const test=require('node:test'),assert=require('node:assert/strict');
const {createLinuxNetwork,splitEscaped}=require('../src/linux-network.cjs');
const {networkSnapshot,resolveNetworkSelection}=require('../src/network-selection.cjs');
const {createCurrentNetworkReader}=require('../src/wlan-reader.cjs');
const wifi='11111111-1111-1111-1111-111111111111',hotspot='22222222-2222-2222-2222-222222222222',saved='33333333-3333-3333-3333-333333333333';
const profile=(uuid,{ssid='公共:网络  ',mode='infrastructure',method='auto',timestamp=1,channel=0}={})=>`connection.id:Profile alias\nconnection.uuid:${uuid}\nconnection.interface-name:wlan0\nconnection.timestamp:${timestamp}\n802-11-wireless.ssid:${ssid}\n802-11-wireless.mode:${mode}\n802-11-wireless.channel:${channel}\nipv4.method:${method}\n`;
const device=(uuid=wifi,route=true)=>`GENERAL.DEVICE:wlan0\nGENERAL.TYPE:wifi\nGENERAL.STATE:100 (connected)\nGENERAL.CON-UUID:${uuid}\nGENERAL.IS-SOFTWARE:no\nGENERAL.PRODUCT:Wireless adapter\nIP4.GATEWAY:${route?'192.0.2.1':''}\n${route?'IP4.ROUTE[1]:dst = 0.0.0.0/0, nh = 192.0.2.1, mt = 600\n':''}`;
function fixture(handler){const calls=[];return {calls,api:createLinuxNetwork({execute(file,args,options,done){calls.push({file,args,options});const value=handler(file,args,options);queueMicrotask(()=>done(value.error,value.out||'',value.stderr||''))}})}}
test('nmcli terse parser preserves escaped colons, backslashes and Unicode spaces',()=>{
 assert.deepEqual(splitEscaped('*: 公共\\:网络  :44:02\\:00\\:00\\:00\\:00\\:01'),['*',' 公共:网络  ','44','02:00:00:00:00:01']);
 assert.deepEqual(splitEscaped('name\\\\value:tail'),['name\\value','tail']);
});
test('Linux Wi-Fi channel, BSSID and password use one exact active interface and UUID',async()=>{
 const {api,calls}=fixture((file,args)=>{
  assert.equal(file,'nmcli');
  if(args.includes('--show-secrets'))return {out:'802-11-wireless-security.key-mgmt:wpa-psk\n802-11-wireless-security.psk:  public:fixture  \n'};
  if(args.includes('wifi'))return {out:'*:公共\\:网络  :44:02\\:00\\:00\\:00\\:00\\:01\n'};
  if(args.includes('uuid'))return {out:profile(wifi)};
  return {out:`${wifi}:802-11-wireless:yes:wlan0\n${hotspot}:802-11-wireless:yes:wlan1\n`};
 });
 const read=createCurrentNetworkReader({platform:'linux',wlan:api.readLinuxWlan});
 const value=await read('lan',{interfaceName:'wlan0'});
 assert.deepEqual(value,{ok:true,mode:'lan',ssid:'公共:网络  ',passwordRead:true,interfaceName:'wlan0',channel:44,bssid:'02:00:00:00:00:01',password:'  public:fixture  '});
 assert.equal(calls.filter(call=>call.args.includes('uuid')).every(call=>call.args.at(-1)===wifi),true);
 assert.equal(calls.every(call=>call.options.env.LC_ALL==='C.UTF-8'),true);
});
test('Linux hotspot configuration and metadata use AP shared mode without reading upstream secrets',async()=>{
 const {api,calls}=fixture((_file,args)=>{
  if(args.at(-1)==='show'&&args.includes('device'))return {out:device(hotspot,false)};
  if(args.includes('--show-secrets')){assert.equal(args.at(-1),hotspot);return {out:'802-11-wireless-security.key-mgmt:wpa-psk\n802-11-wireless-security.psk:public-hotspot\n'}}
  if(args.includes('uuid'))return {out:profile(args.at(-1),args.at(-1)===hotspot?{ssid:'共享热点',mode:'ap',method:'shared',channel:36}:{})};
  return {out:`${wifi}:802-11-wireless:yes:wlan1\n${hotspot}:802-11-wireless:yes:wlan0\n`};
 });
 const metadata=await api.readLinuxNetworkMetadata({mode:'hotspot'}),snapshot=networkSnapshot({wlan0:[{family:'IPv4',address:'10.42.0.1',internal:false}]},metadata);
 const selected=resolveNetworkSelection('hotspot','',snapshot);assert.equal(selected.ok,true);assert.equal(selected.name,'wlan0');assert.equal(selected.item.hotspotSource,'networkmanager');
 assert.equal(calls.some(call=>call.args.includes('--show-secrets')),false);
 const read=createCurrentNetworkReader({platform:'linux',hotspot:api.readLinuxHotspotConfiguration});
 const current=await read('hotspot',{snapshot});
 assert.equal(current.ssid,'共享热点');assert.equal(current.password,'public-hotspot');assert.equal(current.hotspotState,'On');assert.equal(current.channel,36);assert.equal(current.channelKnown,true);assert.equal(current.warning,undefined);
});
test('saved hotspot is readable while Off and newest saved AP profile is selected',async()=>{
 const {api}=fixture((_file,args)=>{
  if(args.includes('--show-secrets')){assert.equal(args.at(-1),saved);return {out:'802-11-wireless-security.key-mgmt:wpa-psk\n802-11-wireless-security.psk:saved-hotspot\n'}}
  if(args.includes('uuid'))return {out:profile(args.at(-1),{ssid:args.at(-1)===saved?'Newest':'Old',mode:'ap',method:'shared',timestamp:args.at(-1)===saved?20:1})};
  return {out:`${hotspot}:802-11-wireless:no:\n${saved}:802-11-wireless:no:\n`};
 });
 const value=await api.readLinuxHotspotConfiguration();assert.equal(value.ok,true);assert.equal(value.state,'Off');assert.equal(value.ssid,'Newest');assert.equal(value.password,'saved-hotspot');
});
test('active AP query failure cannot fall back to an old saved hotspot',async()=>{
 const {api}=fixture((_file,args)=>{
  if(args.includes('uuid'))return args.at(-1)===hotspot?{error:{code:1},stderr:'private-fixture'}:{out:profile(saved,{mode:'ap',method:'shared'})};
  return {out:`${hotspot}:802-11-wireless:yes:wlan0\n${saved}:802-11-wireless:no:\n`};
 });
 const value=await api.readLinuxHotspotConfiguration();assert.equal(value.ok,false);assert.equal('ssid' in value,false);assert.equal(JSON.stringify(value).includes('private-fixture'),false);
});
test('Linux LAN enumeration checks only connected Wi-Fi mode and never classifies a VPN as physical',async()=>{
 const {api,calls}=fixture((_file,args)=>({out:args.includes('uuid')?profile(wifi):device()+'\nGENERAL.DEVICE:wg0\nGENERAL.TYPE:wireguard\nGENERAL.STATE:100 (connected)\nGENERAL.IS-SOFTWARE:yes\n'}));
 const metadata=await api.readLinuxNetworkMetadata({mode:'lan'});assert.equal(calls.length,2);assert.equal(metadata.adapters[1].physical,false);
 assert.equal(calls[1].args.at(-1),wifi);assert.equal(calls.some(call=>call.args.includes('--show-secrets')),false);
 assert.equal(resolveNetworkSelection('lan','',networkSnapshot({wlan0:[{family:'IPv4',address:'192.0.2.2',internal:false}]},metadata)).ok,true);
});
test('Linux physical Wi-Fi running a hotspot is not offered as an existing LAN',async()=>{
 const {api}=fixture((_file,args)=>({out:args.includes('uuid')?profile(hotspot,{mode:'ap',method:'shared'}):device(hotspot,false)}));
 const metadata=await api.readLinuxNetworkMetadata({mode:'lan'}),snapshot=networkSnapshot({wlan0:[{family:'IPv4',address:'10.42.0.1',internal:false}]},metadata);
 assert.equal(snapshot.recommended.lan,'');assert.equal(snapshot.items[0].lan,false);
 assert.equal(resolveNetworkSelection('lan','wlan0',snapshot).ok,false);
});
test('Linux wireless mode lookup failure excludes only that adapter and keeps wired LAN usable',async()=>{
 const wired='\nGENERAL.DEVICE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.IS-SOFTWARE:no\n';
 const {api}=fixture((_file,args)=>args.includes('uuid')?{error:{code:1}}:{out:device()+wired});
 const metadata=await api.readLinuxNetworkMetadata({mode:'lan'}),snapshot=networkSnapshot({wlan0:[{family:'IPv4',address:'10.42.0.1',internal:false}],eth0:[{family:'IPv4',address:'192.0.2.2',internal:false}]},metadata);
 assert.equal(snapshot.queryFailed,false);assert.equal(snapshot.recommended.lan,'eth0');
 assert.equal(resolveNetworkSelection('lan','wlan0',snapshot).ok,false);
 assert.equal(resolveNetworkSelection('lan','eth0',snapshot).ok,true);
 assert.equal(metadata.queries.find(query=>query.stage==='wireless-mode').code,'QUERY_FAILED');
});
test('missing dependencies and cancellation return actionable errors without raw command data',async()=>{
 const {api,calls}=fixture(()=>({error:{code:'ENOENT'},stderr:'secret-private-fixture'}));
 const metadata=await api.readLinuxNetworkMetadata({mode:'lan'}),result=resolveNetworkSelection('lan','',networkSnapshot({},metadata));
 assert.equal(result.ok,false);assert.match(result.error,/安装NetworkManager/);assert.equal(JSON.stringify(result).includes('private-fixture'),false);
 const read=createCurrentNetworkReader({platform:'linux',wlan:api.readLinuxWlan});assert.match((await read('lan')).error,/nmcli/);
 const controller=new AbortController();controller.abort();const before=calls.length;
 assert.equal((await api.readLinuxNetworkMetadata({signal:controller.signal})).queries[0].code,'CANCELLED');assert.equal(calls.length,before);
});
test('Linux Bluetooth enumeration retains the original adapter and paired-device response fields',async()=>{
 const {api,calls}=fixture((file,args)=>{assert.equal(file,'bluetoothctl');return args.includes('show')?{out:'Controller 02:AA:00:00:00:01 Host\n\tPowered: yes\n'}:{out:'Device 02:AB:00:00:00:02 手机:iPhone 15\n'}});
 assert.deepEqual(await api.listBluetoothDevices(),{ok:true,adapter:'02:AA:00:00:00:01',devices:[{name:'手机:iPhone 15',address:'02:AB:00:00:00:02'}]});
 assert.ok(calls[1].args.includes('Paired'));
});
test('Linux Bluetooth reports absent/off adapters and semantic failures even with exit code zero',async()=>{
 for(const [out,code] of [['No default controller available\n','BLUETOOTH_ADAPTER_UNAVAILABLE'],['Controller 02:AA:00:00:00:01 Host\nPowered: no\n','BLUETOOTH_POWERED_OFF']]){
  const {api}=fixture(()=>({out}));assert.equal((await api.listBluetoothDevices()).code,code);
 }
 const {api}=fixture((_file,args)=>({out:args.includes('show')?'Controller 02:AA:00:00:00:01 Host\nPowered: yes\n':'Failed to get devices: org.bluez.Error.NotReady\n'}));
 assert.equal((await api.listBluetoothDevices()).ok,false);
});
