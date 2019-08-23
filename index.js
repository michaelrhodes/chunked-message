module.exports = ChunkedMessage

var bitfield = require('bitfield')
var invert = require('bitfield/invert')
var varint = require('varint/encode')
var decode = require('varint/decode')
var split = require('chunks/split')
var join = require('chunks/join')
var hex = require('hex')

var types = { need: 0, chunk: 1 }

function ChunkedMessage (size, opts) {
  if (!(this instanceof ChunkedMessage)) {
    return new ChunkedMessage(size, opts)
  }

  this.haves = {}
  this.needs = {}

  opts = opts || {}
  this.incoming = opts.incoming
  this.outgoing = opts.outgoing
  this.size = size
}

ChunkedMessage.prototype = {
  handleEvent: handleEvent,
  read: read,
  send: send
}

function handleEvent (e) {
  this.read(e.data || e.detail)
}

function read (buf) {
  var msg = parse(buf)
  if (msg && msg.type === types.need) return onneed(this, msg)
  if (msg && msg.type === types.chunk) return onchunk(this, msg)
}

function send (buf, id) {
  var ctx = this

  // 10 is the max. possible varint length
  var header = 1 + id.byteLength + 10 + 10
  var size = ctx.size - header
  var chunks = ctx.haves[hex.encode(id)] =
    split(new Uint8Array(buf), size)

  ctx.outgoing(chunk(id, {
    lastIndex: varint(chunks.length - 1),
    index: varint(0),
    chunk: chunks.get(0)
  }))

  chunks.atime = Date.now()
  cleanup(ctx, 5000)
}

// Someone is asking for something
function onneed (ctx, msg) {
  var chunks = ctx.haves[hex.encode(msg.id)]
  if (!chunks) return

  var needed = bitfield(msg.body)

  for (var i = 0, l = chunks.length; i < l; i++) {
    if (needed.get(i)) ctx.outgoing(chunk(msg.id, {
      lastIndex: varint(chunks.length - 1),
      index: varint(i),
      chunk: chunks.get(i)
    }))
  }

  chunks.atime = Date.now()
  cleanup(ctx, 5000)
}

// Someone is sending you something
function onchunk (ctx, msg, c) {
  var lastIndex = decode(msg.body, c = 0)
  var index = decode(msg.body, c += decode.bytes)
  var chunk = msg.body.subarray(c += decode.bytes)
  var length = lastIndex + 1

  var chunks = ctx.needs[hex.encode(msg.id)]
  var initial = !chunks

  if (initial) {
    chunks = ctx.needs[hex.encode(msg.id)] = join(length)
    chunks.have = bitfield(length)
  }

  // Store the chunk
  chunks.set(index, chunk)
  chunks.have.set(index, 1)
  chunks.mtime = Date.now()
  console.log('received chunk %s', index + 1)

  if (chunks.complete) return oncomplete(ctx, msg.id)
  if (initial) request(ctx, msg.id)
  cleanup(ctx, 5000)
}

// You have finished receiving something
function oncomplete (ctx, id) {
  var hid = hex.encode(id)
  var buf = ctx.needs[hid].value
  delete ctx.needs[hid]
  ctx.incoming(buf, id)
}

function parse (buf) {
  var u8a = new Uint8Array(buf)
  var body = 1 + (u8a[0] & 127) + 1

  return buf.byteLength > body && {
    type: u8a[0] >> 7,
    id: u8a.subarray(1, body),
    body: u8a.subarray(body)
  }
}

function need (id, needed) {
  var size = 1 + id.byteLength + needed.length
  var view = new Uint8Array(size)
  var c = 0, b, s

  // Append type
  view[c++] = (types.need << 7) + (id.byteLength - 1)

  // Append id
  b = 0, s = id.byteLength
  while (b < s) view[c++] = id[b++]

  // Append needed bitfield
  b  = 0, s = needed.length
  while (b < s) view[c++] = needed[b++]

  return view.buffer
}

function chunk (id, body) {
  var size = 1 + id.byteLength +
    body.lastIndex.length +
    body.index.length +
    body.chunk.byteLength

  var view = new Uint8Array(size)
  var c = 0, b, s

  // Append type
  view[c++] = (types.chunk << 7) + (id.byteLength - 1)

  // Append id
  b = 0, s = id.byteLength
  while (b < s) view[c++] = id[b++]

  // Append last index
  b = 0, s = body.lastIndex.length
  while (b < s) view[c++] = body.lastIndex[b++]

  // Append index
  b = 0, s = body.index.length
  while (b < s) view[c++] = body.index[b++]

  // Append chunk
  b = 0, s = body.chunk.byteLength
  while (b < s) view[c++] = body.chunk[b++]

  return view.buffer
}

// Ask sender for the remaining chunks
function request (ctx, id) {
  var chunks = ctx.needs[hex.encode(id)]
  var needed = invert(chunks.have.buffer)
  ctx.outgoing(need(id, needed))
}

// Remove stale messages
function cleanup (ctx, delay) {
  clearTimeout(ctx.cleanup)
  ctx.cleanup = setTimeout(clean, delay, ctx)

  function clean () {
    var haves = Object.keys(ctx.haves)
    var needs = Object.keys(ctx.needs)
    var now = Date.now()

    haves.forEach(function (id) {
      var atime = ctx.haves[id].atime

      // Remove messages that haven’t been
      // requested in over thirty seconds
      if (now - atime > 30000) {
        console.log('cleaned up outgoing %s', id)
        delete ctx.haves[id]
      }
    })

    needs.forEach(function (id) {
      var need = ctx.needs[id]
      var mtime = need.mtime

      // Remove incomplete messages that haven’t
      // received a chunk in over thirty seconds
      if (now - mtime > 30000) {
        console.log('cleaned up incoming %s', id)
        delete ctx.needs[id]
      }

      // Send a follow-up request for incomplete
      // messages that haven’t received a chunk
      // in over ten seconds
      else if (now - mtime > 10000) {
        console.log('requested incoming %s', id)
        request(ctx, hex.decode(id))
      }
    })

    // Check again shortly
    haves = Object.keys(ctx.haves)
    needs = Object.keys(ctx.needs)
    if (haves.length || needs.length) {
      cleanup(ctx, 10000)
    }
  }
}
