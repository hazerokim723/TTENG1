export function createDictationSlots(phrase: string) {
  let wordPosition = 0
  let blankIndex = 0
  return Array.from(phrase, character => {
    const letter = /^[A-Za-z]$/.test(character)
    if (!letter) { wordPosition = 0; return { character, letter, blankIndex: -1 } }
    const hidden = wordPosition++ >= 2
    return { character, letter, blankIndex: hidden ? blankIndex++ : -1 }
  })
}

export function hiddenDictationAnswer(phrase: string) {
  return createDictationSlots(phrase).filter(slot => slot.blankIndex >= 0).map(slot => slot.character).join('')
}

// One input holds only the missing letters. Spaces and visible prefixes are
// rendered separately, so crossing a word boundary never changes input focus.
export function normalizeDictationInput(phrase: string, input: string) {
  const answer = hiddenDictationAnswer(phrase)
  if (input.trim().toLowerCase() === phrase.toLowerCase()) return answer
  return input.replace(/[^A-Za-z]/g, '').slice(0, answer.length)
}
