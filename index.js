module.exports = ChunkedMessage

var bitfield = require('bitfield')
var invert = require('bitfield/invert')
var split = require('chunks/split')
var join = require('chunks/join')
var xenc = require('hex/encode')
var xdec = require('hex/decode')
var ienc = require('varint/encode')
var idec = require('varint/decode')

var types = { need: 0, chunk: 1 }

function ChunkedMessage (size, opts) {
  if (!(this instanceof ChunkedMessage)) {
    return new ChunkedMessage(size, opts)
  }

  this.haves = new Map
  this.needs = new Map

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

function read (buf, msg) {
  if (msg = parse(buf)) {
    if (msg.type === types.need) return onneed(this, msg)
    if (msg.type === types.chunk) return onchunk(this, msg)
  }
}

function send (buf, id) {
  var ctx = this

  // 10 is the max. possible varint length
  var header = 1 + id.byteLength + 10 + 10
  var size = ctx.size - header
  var chunks = split(new Uint8Array(buf), size)
  ctx.haves.set(xenc(id), chunks)

  ctx.outgoing(chunk(id, {
    lastIndex: ienc(chunks.length - 1),
    index: ienc(0),
    chunk: chunks.get(0)
  }))

  chunks.atime = Date.now()
  cleanup(ctx, 5000)
}

// Someone is asking for something
function onneed (ctx, msg, id) {
  if (!ctx.haves.has(id = xenc(msg.id))) return

  var chunks = ctx.haves.get(id)
  var needed = bitfield(msg.body)

  for (var i = 0, l = chunks.length; i < l; i++) {
    if (needed.get(i)) ctx.outgoing(chunk(msg.id, {
      lastIndex: ienc(chunks.length - 1),
      index: ienc(i),
      chunk: chunks.get(i)
    }))
  }

  chunks.atime = Date.now()
  cleanup(ctx, 5000)
}

// Someone is sending you something
function onchunk (ctx, msg, c) {
  var lastIndex = idec(msg.body, c = 0)
  var index = idec(msg.body, c += idec.bytes)
  var chunk = msg.body.subarray(c += idec.bytes)
  var length = lastIndex + 1

  var id = xenc(msg.id)
  var existing = ctx.needs.has(id)
  var chunks = existing && ctx.needs.get(id)

  // Setup stores
  if (!existing) {
    chunks = join(length)
    chunks.have = bitfield(length)
    ctx.needs.set(id, chunks)
  }

  // Store the chunk
  chunks.set(index, chunk)
  chunks.have.set(index, 1)
  chunks.mtime = Date.now()
  console.log('received chunk %s', index + 1)

  if (chunks.complete) return oncomplete(ctx, msg.id)
  if (!existing) request(ctx, msg.id)
  cleanup(ctx, 5000)
}

// You have finished receiving something
function oncomplete (ctx, id) {
  var hid = xenc(id)
  var buf = ctx.needs.get(hid).value
  ctx.needs.delete(hid)
  ctx.incoming(buf, id)
}

function parse (buf) {
  var u8a = new Uint8Array(buf)
  var eoh = 1 + (u8a[0] & 127) + 1

  return buf.byteLength > eoh && {
    type: u8a[0] >> 7,
    id: u8a.subarray(1, eoh),
    body: u8a.subarray(eoh)
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
  var chunks = ctx.needs.get(xenc(id))
  var needed = invert(chunks.have.buffer)
  ctx.outgoing(need(id, needed))
}

// Remove stale messages
function cleanup (ctx, delay) {
  clearTimeout(ctx.cleanup)
  ctx.cleanup = setTimeout(clean, delay, ctx)

  function clean () {
    var now = Date.now()

    ctx.haves.forEach(function (have, id) {
      // Remove messages that haven’t been
      // requested in over sixty seconds
      if (now - have.atime > 60000) {
        console.log('cleaned up outgoing %s', id)
        ctx.haves.delete(id)
      }
    })

    ctx.needs.forEach(function (need, id) {
      // Remove incomplete messages that haven’t
      // received a chunk in over sixty seconds
      if (now - need.mtime > 60000) {
        console.log('cleaned up incoming %s', id)
        ctx.needs.delete(id)
      }

      // Send a follow-up request for incomplete
      // messages that haven’t received a chunk
      // in over ten seconds
      else if (now - need.mtime > 10000) {
        console.log('requested incoming %s', id)
        request(ctx, xdec(id))
      }
    })

    // Check again shortly
    if (ctx.haves.size || ctx.needs.size) {
      cleanup(ctx, 10000)
    }
  }
}
