import assert from 'node:assert/strict';
import {test} from 'node:test';
import {disconnectAllowed,validTenant} from './lifecycle-policy.ts';
test('Flow A disconnect never terminates an application browser',()=>{assert.equal(disconnectAllowed('apply'),false);assert.equal(disconnectAllowed('connect'),true);assert.equal(disconnectAllowed('idle'),true)});
test('tenant indices cannot escape tenant1-10 port/profile space',()=>{assert.equal(validTenant('10'),10);for(const value of ['11','0','-1','1/foo','1.5','NaN'])assert.equal(validTenant(value),null)});
