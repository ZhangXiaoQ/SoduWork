'use strict';

const { check } = require('./soduwork-brand-scan.cjs');

const result = check();
console.log(JSON.stringify(result, null, 2));
for (const error of result.errors) console.error(error);
if (!result.ok) process.exitCode = 1;
