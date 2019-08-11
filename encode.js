module.exports = function (BYTES) {
  var SET = 'setUint'
  var HEADER_BYTES = BYTES.TYPE + BYTES.ID + BYTES.INDEX + BYTES.INDEX
  var BODY_BYTES = BYTES.MESSAGE - HEADER_BYTES

  return function encoder (type, id, message) {
    var last = Math.ceil(message.byteLength / (BYTES.MESSAGE - HEADER_BYTES)) - 1

    return function encode (n) {
      if (n > last || n < 0) return

      // Determine body size
      var start = n * BODY_BYTES
      var end = Math.min(message.byteLength, start + BODY_BYTES)

      var c = 0, i = 0
      var encoded = new ArrayBuffer(HEADER_BYTES + end - start)
      var view = new DataView(encoded)

      // Append type
      view[SET + BYTES.TYPE * 8](c, type)
      c += BYTES.TYPE

      // Append id
      while (i < BYTES.ID)
        view.setUint8(c++, id[i++])

      // Append last index
      view[SET + BYTES.INDEX * 8](c, last)
      c += BYTES.INDEX

      // Append index
      view[SET + BYTES.INDEX * 8](c, n)
      c += BYTES.INDEX

      // Append message chunk
      while (start < end)
        view.setUint8(c++, message[start++])

      return encoded
    }
  }
}
