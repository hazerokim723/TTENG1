import test from 'node:test'
import assert from 'node:assert/strict'
import { shortWordMeaning } from '../src/shortWordMeaning.ts'

test('ordinary meaning is brief even when an old cache contains a long explanation', () => {
  assert.equal(shortWordMeaning('강둑. 이 문장에서는 은행이 아닌 강가를 뜻합니다.'), '강둑')
  assert.equal(shortWordMeaning('계획, 방안\n예문: a plan'), '계획, 방안')
  assert.equal(shortWordMeaning('생각해 내다'), '생각해 내다')
  assert.ok(shortWordMeaning('긴 설명 '.repeat(50)).length <= 40)
})
