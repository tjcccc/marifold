import * as dgram from 'node:dgram';

export async function localStun() {
  // A minimal binding responder; no public network or deployed bridge is used.
  const stun = dgram.createSocket('udp4');
  stun.on('message', (request, remote) => {
    if (request.length < 20 || request.readUInt16BE(0) !== 1) return;
    const response = Buffer.alloc(32);
    request.copy(response, 0, 0, 20);
    response.writeUInt16BE(0x0101, 0); response.writeUInt16BE(12, 2);
    response.writeUInt16BE(0x0020, 20); response.writeUInt16BE(8, 22);
    response[25] = 1; response.writeUInt16BE(remote.port ^ 0x2112, 26);
    remote.address.split('.').forEach((part, i) => { response[28 + i] = Number(part) ^ response[4 + i]; });
    stun.send(response, remote.port, remote.address);
  });
  await new Promise<void>(resolve => stun.bind(0, '127.0.0.1', resolve));
  return { url: `stun:127.0.0.1:${stun.address().port}`, close: () => stun.close() };
}
