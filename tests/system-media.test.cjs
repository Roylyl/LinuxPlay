const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const hasSessionRunner = process.platform === 'linux' && !spawnSync('dbus-run-session', ['--version'], {stdio:'ignore'}).error;
test('Linux MPRIS publishes metadata, preserves artwork, receives transport and seek controls, and removes its session', {skip:!hasSessionRunner, timeout:15000}, () => {
 const result = spawnSync('dbus-run-session', ['--', process.execPath, path.join(__dirname, 'fixtures/mpris-session.cjs')], {encoding:'utf8', timeout:12000, env:{...process.env, ELECTRON_RUN_AS_NODE:'1'}});
 assert.ifError(result.error);
 assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Linux media bridge reports an unavailable D-Bus session and exits', {skip:process.platform !== 'linux', timeout:8000}, () => {
 const result = spawnSync(process.execPath, [path.join(__dirname, '../src/mpris-bridge.cjs')], {encoding:'utf8', timeout:6500, env:{...process.env, ELECTRON_RUN_AS_NODE:'1', DBUS_SESSION_BUS_ADDRESS:'unix:path=/nonexistent/linuxplay-test-bus'}});
 assert.ifError(result.error);
 assert.equal(result.status, 1);
 assert.match(result.stderr, /Linux系统媒体D-Bus不可用/);
 assert.doesNotMatch(result.stdout, /"type":"ready"/);
});
