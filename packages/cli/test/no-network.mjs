// Loaded with `node --import` to prove a run touches no network. Every way Node offers to open
// a connection or resolve a name throws, and each attempt is also appended to the file named by
// UPFLY_NETWORK_LOG, so an attempt that some library catches still shows.
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const log = process.env.UPFLY_NETWORK_LOG;

/** @param {string} api */
function refuse(api) {
  return function refused() {
    if (log) appendFileSync(log, `${api}\n`);
    throw new Error(`network access attempted: ${api}`);
  };
}

/**
 * @param {string} moduleName
 * @param {readonly string[]} names
 */
function block(moduleName, names) {
  const target = require(moduleName);
  const label = moduleName.replace(/^node:/, '');
  for (const name of names) {
    if (typeof target[name] === 'function') target[name] = refuse(`${label}.${name}`);
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

// An ES module that imports `connect` from `node:net` reads the export as it stood when the
// builtin was first loaded; this brings every such export up to date with the replacements.
syncBuiltinESMExports();
