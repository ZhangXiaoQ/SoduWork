'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { create, METHODS } = require('./replica-store.cjs');
const store = create(workerData.file);
parentPort.on('message', ({ id, method, args }) => {
  try {
    if (!METHODS.includes(method)) throw Error('Unsupported local history operation');
    parentPort.postMessage({ id, value: store[method](...args) });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
