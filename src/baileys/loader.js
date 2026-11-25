// Carrega o Baileys (pacote ESM) a partir deste projeto CommonJS.
// Fica isolado num módulo próprio para os testes trocarem o socket por um mock (jest.mock).
let cached = null

const loadBaileys = async () => {
  if (!cached) {
    cached = import('@whiskeysockets/baileys').then((mod) => {
      const makeWASocket = typeof mod.makeWASocket === 'function'
        ? mod.makeWASocket
        : (typeof mod.default === 'function' ? mod.default : mod.default?.default)
      return { ...mod, makeWASocket }
    }).catch((err) => {
      cached = null
      throw err
    })
  }
  return cached
}

module.exports = { loadBaileys }
