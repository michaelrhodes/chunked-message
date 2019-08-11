module.exports = message

var encode = require('./encode')
var decode = require('./decode')

function message (BYTES) {
  return {
    encode: encode(BYTES),
    decode: decode(BYTES)
  }
}
