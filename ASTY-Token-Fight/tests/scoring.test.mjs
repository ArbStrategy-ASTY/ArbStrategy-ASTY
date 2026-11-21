import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateScore,priceChange} from '../src/scoring.mjs';

test('50% voting and 50% price: 30/20 votes, +5%/+3% return -> 65% / 35%',()=>{
  const s=calculateScore(30,20,100,105,100,103);
  assert.ok(Math.abs(s.voteShareA-60)<1e-9);
  assert.ok(Math.abs(s.priceShareA-70)<1e-9);
  assert.ok(Math.abs(s.scoreA-65)<1e-9);
  assert.equal(s.winner,'a');
});
test('each 0.1 percentage point relative advantage equals one category point',()=>{
  const s=calculateScore(1,1,100,100.1,100,100);
  assert.ok(Math.abs(s.priceShareA-51)<1e-8);
  assert.ok(Math.abs(s.scoreA-50.5)<1e-8);
});
test('600/400 votes against +4%/+10% price is capped at 30:70',()=>{
  const s=calculateScore(600,400,100,104,100,110);
  assert.ok(Math.abs(s.voteShareA-60)<1e-9);
  assert.equal(s.priceShareA,0);
  assert.equal(s.scoreA,30);
  assert.equal(s.scoreB,70);
  assert.equal(s.winner,'b');
});
test('no votes defaults to balanced 50/50 voting category',()=>{
  const s=calculateScore(0,0,10,10,10,10);
  assert.equal(s.voteShareA,50);
  assert.equal(s.scoreA,50);
  assert.equal(s.winner,'draw');
});
test('price category capped at 0 and 100, never outside',()=>{
  const s=calculateScore(0,0,1,20,1,1);
  assert.equal(s.priceShareA,100);
  assert.equal(s.scoreA,75);
});
test('reject missing or zero prices',()=>assert.equal(calculateScore(1,1,0,1,1,2),null));
test('price change includes losses',()=>assert.ok(Math.abs(priceChange(5,4)+20)<1e-9));
