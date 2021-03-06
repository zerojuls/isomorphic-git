// My version of git-list-pack - roughly 15x faster than the original
// It's used slightly differently - instead of returning a through stream it wraps a stream.
// (I tried to make it API identical, but that ended up being 2x slower than this version.)
import pako from 'pako'
import Hash from 'sha.js/sha1'

import { E, GitError } from '../models/GitError.js'

import { StreamReader } from './StreamReader.js'

export function listpack (stream) {
  var onData = null
  let reader = new StreamReader(stream)
  // Cheap-o off-brand "stream"
  return {
    on (event, callback) {
      if (event === 'data') onData = callback
      _listpack(reader, onData)
    }
  }
}

async function _listpack (reader, push) {
  let hash = new Hash()
  let PACK = await reader.read(4)
  hash.update(PACK)
  let version = await reader.read(4)
  hash.update(version)
  version = version.readUInt32BE(0)
  let numObjects = await reader.read(4)
  hash.update(numObjects)
  numObjects = numObjects.readUInt32BE(0)

  while (!reader.eof() && numObjects--) {
    let offset = reader.tell()
    let { type, length, ofs, reference } = await parseHeader(reader, hash)
    let inflator = new pako.Inflate()
    while (!inflator.result) {
      let chunk = await reader.chunk()
      if (reader.ended) break
      inflator.push(chunk, false)
      if (inflator.err) {
        throw new GitError(E.InternalFail, {
          message: inflator.msg
        })
      }
      if (inflator.result) {
        if (inflator.result.length !== length) {
          throw new GitError(E.InternalFail, {
            message: `Inflated object size is different from that stated in packfile.`
          })
        }

        // Backtrack parser to where deflated data ends
        await reader.undo()
        let buf = await reader.read(chunk.length - inflator.strm.avail_in)
        hash.update(buf)
        let end = reader.tell()
        push({
          data: inflator.result,
          type,
          num: numObjects,
          offset,
          end,
          reference,
          ofs
        })
      } else {
        hash.update(chunk)
      }
    }
  }
}

async function parseHeader (reader, hash) {
  // Object type is encoded in bits 654
  let byte = await reader.byte()
  hash.update(Buffer.from([byte]))
  let type = (byte >> 4) & 0b111
  // The length encoding get complicated.
  // Last four bits of length is encoded in bits 3210
  let length = byte & 0b1111
  // Whether the next byte is part of the variable-length encoded number
  // is encoded in bit 7
  if (byte & 0b10000000) {
    let shift = 4
    do {
      byte = await reader.byte()
      hash.update(Buffer.from([byte]))
      length |= (byte & 0b01111111) << shift
      shift += 7
    } while (byte & 0b10000000)
  }
  // Handle deltified objects
  let ofs
  let reference
  if (type === 6) {
    let shift = 0
    ofs = 0
    let bytes = []
    do {
      byte = await reader.byte()
      hash.update(Buffer.from([byte]))
      ofs |= (byte & 0b01111111) << shift
      shift += 7
      bytes.push(byte)
    } while (byte & 0b10000000)
    reference = Buffer.from(bytes)
  }
  if (type === 7) {
    let buf = await reader.read(20)
    hash.update(buf)
    reference = buf
  }
  return { type, length, ofs, reference }
}
