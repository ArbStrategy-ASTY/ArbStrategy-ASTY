import test from 'node:test';
import assert from 'node:assert/strict';
import {countdownThreshold} from '../src/countdown.mjs';

test('15 minute reminder window',()=>{
  assert.equal(countdownThreshold(901),null);
  assert.equal(countdownThreshold(900),15);
  assert.equal(countdownThreshold(899),15);
  assert.equal(countdownThreshold(601),15);
});
test('10 minute reminder window',()=>{
  assert.equal(countdownThreshold(600),10);
  assert.equal(countdownThreshold(599),10);
  assert.equal(countdownThreshold(301),10);
});
test('5 minute reminder window and no reminders after end',()=>{
  assert.equal(countdownThreshold(300),5);
  assert.equal(countdownThreshold(1),5);
  assert.equal(countdownThreshold(0),null);
  assert.equal(countdownThreshold(-1),null);
});
test('invalid remaining time never schedules a reminder',()=>{
  assert.equal(countdownThreshold(NaN),null);
  assert.equal(countdownThreshold(Infinity),null);
});
