import test from 'node:test';
import assert from 'node:assert/strict';
import {vectorText,vectorWidth} from '../src/vector-font.mjs';

test('renders token tickers as vector paths without external fonts',()=>{
  const svg=vectorText('$ASTY',300,200,{pixel:11,align:'middle'});
  assert.match(svg,/<path /);
  assert.doesNotMatch(svg,/<text/);
  assert.match(svg,/translate\(/);
});
test('shows both token symbols and complete brand text with outline glyphs',()=>{
  for(const value of ['$ASTY','$ARBX','ASTY TOKEN FIGHT','POWERED BY ASTY - ARBSTRATEGY.NET']){
    assert.ok(vectorText(value,600,90).includes('<path '),value);
  }
});
test('long token ticker text fits within the specified maximum width',()=>{
  const svg=vectorText('$SUPERCALIFRAGILISTIC',600,430,{pixel:12,align:'middle',maxWidth:380});
  assert.ok(svg.includes('scale('));
  assert.ok(vectorWidth('$ASTY',10)>0);
});
test('safe fallback for unsupported characters',()=>{
  assert.ok(vectorText('$A♥',200,100).includes('<path '));
});
