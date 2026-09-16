import assert from 'node:assert/strict';
import {test} from 'node:test';
import {disconnectAllowed,validTenant,gatewayLifecycleAction} from './lifecycle-policy.ts';
test('Flow A disconnect never terminates an application browser',()=>{assert.equal(disconnectAllowed('apply'),false);assert.equal(disconnectAllowed('connect'),true);assert.equal(disconnectAllowed('idle'),true)});
test('tenant indices cannot escape tenant1-10 port/profile space',()=>{assert.equal(validTenant('10'),10);for(const value of ['11','0','-1','1/foo','1.5','NaN'])assert.equal(validTenant(value),null)});

test('extension clients are stopped before Flow A and only started after Flow B is ready',()=>{
 assert.equal(gatewayLifecycleAction('connect','before_chrome'),'stop');
 assert.equal(gatewayLifecycleAction('connect','after_chrome_ready'),null);
 assert.equal(gatewayLifecycleAction('apply','before_chrome'),null);
 assert.equal(gatewayLifecycleAction('apply','after_chrome_ready'),'start');
 assert.equal(gatewayLifecycleAction('idle','before_chrome'),null);
});
