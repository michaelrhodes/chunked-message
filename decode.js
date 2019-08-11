module.exports = function (BYTES) {
  var GET = 'getUint'

  return function decode (encoded) {
    var message = {
      type: null,
      id: null,
      lastIndex: null,
      index: null,
      body: null
    }

    var view = new DataView(encoded)
    var array = new Uint8Array(encoded)
    var c = 0

    message.type = view[GET + BYTES.TYPE * 8](c)
    message.id = array.slice(c += BYTES.TYPE, c += BYTES.ID)
    message.lastIndex = view[GET + BYTES.INDEX * 8](c)
    message.index = view[GET + BYTES.INDEX * 8](c += BYTES.INDEX)
    message.body = array.slice(c += BYTES.INDEX)

    return message
  }
}
