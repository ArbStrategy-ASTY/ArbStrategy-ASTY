import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProjectWebsite,projectWebsiteDisplay} from '../src/website.mjs';

test('accepts project domains and HTTPS links',()=>{
  assert.equal(normalizeProjectWebsite('arbstrategy.net'),'https://arbstrategy.net/');
  assert.equal(normalizeProjectWebsite('https://arbstrategy.net'),'https://arbstrategy.net/');
  assert.equal(normalizeProjectWebsite('https://arbstrategy.net/dashboard'),'https://arbstrategy.net/dashboard');
  assert.equal(projectWebsiteDisplay('https://www.arbstrategy.net/path'),'arbstrategy.net');
});
test('removes fragment, keeping a safe project path',()=>{
  assert.equal(normalizeProjectWebsite('https://example.org/info#private'),'https://example.org/info');
});
test('rejects credentials, unencrypted HTTP, non-HTTPS schemes and ports',()=>{
  for(const url of ['http://example.org','javascript:alert(1)','ftp://example.org','https://user:pass@example.org','https://example.org:8123']){
    assert.equal(normalizeProjectWebsite(url),null,url);
  }
});
test('rejects IPs, local hosts and non-public sites',()=>{
  for(const url of ['https://127.0.0.1','https://localhost','https://foo.local','https://project.invalid','https://1.2.3.4']){
    assert.equal(normalizeProjectWebsite(url),null,url);
  }
});
test('rejects unsafe or huge links',()=>{
  for(const url of ['https://example.org/space here','https://example.org/\\nwrong','https://example.org/'.padEnd(180,'a')]){
    assert.equal(normalizeProjectWebsite(url),null,url);
  }
});
