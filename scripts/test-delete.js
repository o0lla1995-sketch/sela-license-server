/** Quick test: key hard-delete endpoint cascades bindings + payments. */
'use strict';
const {spawn} = require('child_process');
const fs = require('fs');

const env = {
  ...process.env,
  PORT: '3997',
  DATA_DIR: '/tmp/sela-del-test',
  ADMIN_EMAIL: 'o@t.co',
  ADMIN_PASSWORD: 'pass123456',
};
fs.rmSync('/tmp/sela-del-test', {recursive: true, force: true});
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: __dirname + '/..',
  env,
  stdio: 'ignore',
});

async function main() {
  await new Promise(r => setTimeout(r, 1200));
  const base = 'http://127.0.0.1:3997';
  const login = await (
    await fetch(base + '/api/admin/auth/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({email: 'o@t.co', password: 'pass123456'}),
    })
  ).json();
  const T = login.token;
  const H = {Authorization: 'Bearer ' + T, 'Content-Type': 'application/json'};

  const created = await (
    await fetch(base + '/api/admin/keys', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({planDays: 30, count: 1, price: 50}),
    })
  ).json();
  const id = created.keys[0].id;

  await fetch(base + '/api/v1/activate', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({key: created.keys[0].key, deviceId: 'del-test-dev'}),
  });
  await fetch(base + `/api/admin/keys/${id}/pay`, {
    method: 'POST',
    headers: H,
    body: '{}',
  });

  const del = await (
    await fetch(base + `/api/admin/keys/${id}/delete`, {
      method: 'POST',
      headers: H,
    })
  ).json();
  const list = await (
    await fetch(base + '/api/admin/keys', {headers: H})
  ).json();
  const stats = await (
    await fetch(base + '/api/admin/stats', {headers: H})
  ).json();

  console.log(
    'delete ok:', del.ok,
    '| keys after:', list.keys.length,
    '| revenue after delete:', stats.revenue.total,
  );
  server.kill();
  process.exit(del.ok && list.keys.length === 0 && stats.revenue.total === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  server.kill();
  process.exit(1);
});
