// Preloaded with `node --require` to prove a run touches no network. Every way Node offers
// to open a connection or resolve a name throws, and each attempt is also appended to the
// file named by UPFLY_NETWORK_LOG, so an attempt that some library catches still shows.
const fs = require('node:fs');

const log = process.env.UPFLY_NETWORK_LOG;

function refuse(api) {
  return function refused() {
    if (log) fs.appendFileSync(log, `${api}\n`);
    throw new Error(`network access attempted: ${api}`);
  };
}

function block(moduleName, names) {
  const target = require(moduleName);
  for (const name of names) {
    if (typeof target[name] === 'function') target[name] = refuse(`${moduleName}.${name}`);
  }
  return target;
}

const net = block('node:net', ['connect', 'createConnection']);
net.Socket.prototype.connect = refuse('net.Socket.connect');
block('node:tls', ['connect']);
block('node:http', ['request', 'get']);
block('node:https', ['request', 'get']);
block('node:http2', ['connect']);
block('node:dgram', ['createSocket']);
const dns = block('node:dns', [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCname',
  'resolveMx',
  'resolveNs',
  'resolveSrv',
  'resolveTxt',
  'reverse',
]);
for (const name of Object.keys(dns.promises)) {
  if (typeof dns.promises[name] === 'function') dns.promises[name] = refuse(`dns.promises.${name}`);
}
// The real `fetch` reports failure by rejecting, so the refusal does too.
const refuseFetch = refuse('fetch');
globalThis.fetch = async () => refuseFetch();
