// SPDX-License-Identifier: GPL-3.0-or-later
const {createInterface} = require('node:readline');
const {MprisService} = require('./mpris-service.cjs');

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let closing = false, reader, startupTimer;
const service = new MprisService(send, fail);
function stop() {
 if (closing) return;
 closing = true;
 clearTimeout(startupTimer);
 service.dispose();
 reader?.close();
 process.stdin.destroy();
}
function fail(error) {
 if (closing) return;
 process.stderr.write('Linux系统媒体D-Bus不可用：' + (error?.message || String(error)) + '\n');
 process.exitCode = 1;
 stop();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('exit', () => service.dispose());
process.stdout.on('error', stop);
process.stdin.on('error', fail);

(async () => {
 startupTimer = setTimeout(() => fail(Error('连接会话总线超时')), 5000);
 try { await service.start(); } finally { clearTimeout(startupTimer); }
 if (closing) return;
 reader = createInterface({input:process.stdin, crlfDelay:Infinity});
 send({type:'ready'});
 for await (const line of reader) {
  if (closing) break;
  try {
   const message = JSON.parse(line);
   if (!message || typeof message !== 'object') continue;
   if (message.command === 'stop') break;
   if (message.command === 'update') await service.update(message);
   else if (message.command === 'position') service.setPosition(message.positionMs);
   else if (message.command === 'clear') await service.clear();
  } catch (error) { send({type:'error', reason:error?.message || String(error)}); }
 }
 stop();
})().catch(fail);
