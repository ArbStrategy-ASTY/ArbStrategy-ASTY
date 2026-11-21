import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateScore,priceChange} from '../src/scoring.mjs';
test('promised 600/400 votes versus +4/+10 prices -> 47.5/52.5', ()=>{
 const s=calculateScore(600,400,100,104,100,110);
 assert.ok(Math.abs(s.scoreA-47.5)<1e-9); assert.equal(s.winner,'b');
});
test('no votes is balanced',()=>{const s=calculateScore(0,0,10,10,10,10);assert.equal(s.scoreA,50);assert.equal(s.winner,'draw')});
test('large moves are capped',()=>{const s=calculateScore(0,0,1,20,1,1);assert.equal(s.priceShareA,100);assert.equal(s.scoreA,75)});
test('reject missing prices',()=>assert.equal(calculateScore(1,1,0,1,1,2),null));
test('return handles losses',()=> assert.ok(Math.abs(priceChange(5,4)+20)<1e-9));
