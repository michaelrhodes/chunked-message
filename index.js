module.exports = ChunkedMessage

var bitfield = require('bitfield')
var invert = require('bitfield/invert')
var split = require('chunks/split')
var join = require('chunks/join')
var ve = require('varint/encode')
var vd = require('varint/decode')
var he = require('hex/encode')
var hd = require('hex/decode')

var types = { need: 0, chunk: 1 }

function ChunkedMessage (size, opts) {
  if (!(this instanceof ChunkedMessage)) {
    return new ChunkedMessage(size, opts)
  }

  opts = opts || {}
  this.incoming = opts.incoming
  this.outgoing = opts.outgoing
  this.needs = new Map
  this.haves = new Map
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

  // Indices will probably be less than 10 bytes,
  // but it’s simplest to just reserve the space
  var header = 1 + id.byteLength + 10 + 10
  var size = ctx.size - header
  var chunks = split(new Uint8Array(buf), size)
  ctx.haves.set(he(id), chunks)

  // Send the first chunk
  ctx.outgoing(chunk(id, {
    chunk: chunks.get(0),
    index: ve(0),
    lastIndex: ve(chunks.length - 1)
  }))

  console.log('[%s] sent chunk 1', fmt(he(id)))

  // Begin countdown to cleanup
  chunks.atime = Date.now()
  cleanup(ctx, 5000)
}

// Someone is asking for something
function onneed (ctx, msg, id) {
  if (!ctx.haves.has(id = he(msg.id))) return

  var chunks = ctx.haves.get(id)
  var needed = bitfield(msg.body)
  var last = chunks.length - 1

  console.log('[%s] received chunk request', fmt(id))

  // Send them every chunk they need
  for (var i = 0; i <= last; i++) {
    if (needed.get(i)) ctx.outgoing(chunk(msg.id, {
      chunk: chunks.get(i),
      index: ve(i),
      lastIndex: ve(last)
    })),
    console.log('[%s] sent chunk %s', fmt(id), i + 1)
  }

  // Restart countdown to cleanup
  chunks.atime = Date.now()
  cleanup(ctx, 5000)
}

// Someone is sending you something
function onchunk (ctx, msg, o) {
  var lastIndex = vd(msg.body, o = 0)
  var index = vd(msg.body, o += vd.bytes)
  var chunk = msg.body.subarray(o += vd.bytes)
  var length = lastIndex + 1

  var id = he(msg.id)
  var needed = ctx.needs.has(id)
  var chunks = needed && ctx.needs.get(id)

  if (!needed) {
    chunks = join(length)
    chunks.have = bitfield(length)
    ctx.needs.set(id, chunks)
  }

  // Store the chunk
  chunks.set(index, chunk)
  chunks.have.set(index, 1)
  chunks.mtime = Date.now()

  console.log('[%s] received chunk %s', fmt(id), index + 1)

  if (chunks.complete) return oncomplete(ctx, msg.id)
  if (!needed) request(ctx, msg.id)
  cleanup(ctx, 5000)
}

// You have finished receiving something
function oncomplete (ctx, id) {
  var hid = he(id)
  var buf = ctx.needs.get(hid).value
  ctx.incoming(buf, id)
  ctx.needs.delete(hid)
  console.log('[%s] received + cleaned up incoming', fmt(hid), buf)
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
  var chunks = ctx.needs.get(he(id))
  var needed = invert(chunks.have.buffer)
  ctx.outgoing(need(id, needed))
  console.log('[%s] sent chunk request', fmt(he(id)))
}

// Remove stale messages
function cleanup (ctx, delay) {
  clearTimeout(ctx.cleanup)
  ctx.cleanup = setTimeout(clean, delay, ctx)

  function clean () {
    var now = Date.now()

    ctx.haves.forEach(function (have, id) {
      // Remove messages that haven’t been
      // requested in over thirty seconds
      if (now - have.atime > 60000) {
        ctx.haves.delete(id)
        console.log('[%s] cleaned up outgoing', fmt(id))
      }
    })

    ctx.needs.forEach(function (need, id) {
      // Remove incomplete messages that haven’t
      // received a chunk in over sixty seconds
      if (now - need.mtime > 60000) {
        ctx.needs.delete(id)
        console.log('[%s] cleaned up incoming', fmt(id))
      }

      // Send a follow-up request for incomplete
      // messages that haven’t received a chunk
      // in over ten seconds
      else if (now - need.mtime > 10000) {
        request(ctx, hd(id))
      }
    })

    // Check again shortly
    if (ctx.haves.size || ctx.needs.size) {
      cleanup(ctx, 10000)
    }
  }
}

function fmt (id) {
  return id.length > 8 ?
   (id.substr(0, 5) + '..' + id.substr(-2)) :
    id
}
