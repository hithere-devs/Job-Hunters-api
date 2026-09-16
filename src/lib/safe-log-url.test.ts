import assert from 'node:assert/strict';import {test}from'node:test';import{safeLogUrl}from'./safe-log-url.js';
test('stream bearer and OAuth credentials are redacted from request logs',()=>{const s=safeLogUrl('/live/1?token=secret-token&code=secret-code&state=secret-state&page=2');assert(!s.includes('secret-'));assert(s.includes('page=2'));});
