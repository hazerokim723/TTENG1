import test from 'node:test'
import assert from 'node:assert/strict'
import { createDictationSlots, hiddenDictationAnswer, normalizeDictationInput } from '../src/dictationInput.ts'

const display = (phrase, input) => createDictationSlots(phrase).map(slot => slot.blankIndex < 0 ? slot.character : input[slot.blankIndex] || '_').join('')

test('GOOD WILL: OD then LL skips the space and visible WI', () => {
  assert.equal(display('GOOD WILL', ''), 'GO__ WI__')
  assert.equal(display('GOOD WILL', 'O'), 'GOO_ WI__')
  assert.equal(display('GOOD WILL', 'OD'), 'GOOD WI__')
  assert.equal(display('GOOD WILL', 'ODL'), 'GOOD WIL_')
  assert.equal(display('GOOD WILL', 'ODLL'), 'GOOD WILL')
  assert.equal(hiddenDictationAnswer('GOOD WILL'), 'ODLL')
})

test('only missing letters are entered for single and multiple words', () => {
  for (const phrase of ['restitution', 'come up with', 'on the verge of', 'make-up', "don't give up"]) {
    assert.equal(display(phrase, hiddenDictationAnswer(phrase)), phrase)
  }
  assert.equal(hiddenDictationAnswer('come up with'), 'meth')
  assert.equal(display('the', ''), 'th_')
})

test('spaces are optional and full-answer paste is accepted', () => {
  assert.equal(normalizeDictationInput('GOOD WILL', 'od ll'), 'odll')
  assert.equal(normalizeDictationInput('GOOD WILL', 'good will'), 'ODLL')
  assert.equal(normalizeDictationInput('GOOD WILL', 'odllxxxx'), 'odll')
})

test('wrong answers stay wrong and backspace can cross a word boundary', () => {
  assert.notEqual(normalizeDictationInput('GOOD WILL', 'odlx').toLowerCase(), hiddenDictationAnswer('GOOD WILL').toLowerCase())
  assert.equal(display('GOOD WILL', 'OD'), 'GOOD WI__')
  assert.equal(display('GOOD WILL', 'O'), 'GOO_ WI__')
})
