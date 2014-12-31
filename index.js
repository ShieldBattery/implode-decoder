var Transform = require('stream').Transform
  , inherits = require('inherits')

function createDecoderStream() {
  return new Decoder()
}

var STATE_HEADER = 0
  , STATE_DECODE = 1
  , STATE_REPEATED_LITERAL = 2
  , STATE_REPEATED_EXTRA_LENGTH = 3
  , STATE_BINARY_LITERAL = 4
  , STATE_ASCII_LITERAL = 5
  , STATE_ASCII_INTERPRET_RESULT = 6
  , STATE_INTERPRET_REPEATED_LITERAL = 7
  , STATE_GET_DISTANCE_BITS = 8
  , STATE_WRITE_REPEATED_LITERAL = 9
  , STATE_WRITE_SINGLE_LITERAL = 10
  , STATE_TERMINATED = 100
  , STATE_ERROR = 666
var CT_BINARY = 0
  , CT_ASCII = 1
var END_MARKER = 0x10E

inherits(Decoder, Transform)
function Decoder() {
  Transform.call(this)

  this.state = STATE_HEADER
  this.compressionType = -1
  this.dictionarySizeBits = -1
  this.dictionarySizeMask = 0xFFFF
  this.bitBuffer = -1
  this.extraBits = -1

  this.inBuffer = null
  this.inPos = 0
  this.awaitingData = false
  this.workBuffer = null
  this.workPos = -1
  this.stateStore = {}

  if (!Decoder.lengthCodes) {
    Decoder.lengthCodes = genDecodeTables(lenCode, lenBits)
  }
  this.lengthCodes = Decoder.lengthCodes

  if (!Decoder.distPosCodes) {
    Decoder.distPosCodes = genDecodeTables(distCode, distBits)
  }
  this.distPosCodes = Decoder.distPosCodes
}

Decoder.prototype.isDecoding = function() {
  return this.state >= STATE_DECODE && this.state < STATE_ERROR
}

Decoder.prototype._transform = function(block, encoding, done) {
  if (this.state == STATE_HEADER) {
    this.readHeader(block)
  } else {
    this.inBuffer = block
    this.inPos = 0
    this.awaitingData = false
  }

  if (this.isDecoding()) {
    this.decode()
  }

  done()
}

Decoder.prototype._flush = function(done) {
  if (this.state == STATE_HEADER) {
    this.inBuffer = null
    this.workBuffer = null
    return done(new Error('Not enough data to decode'))
  }

  if (this.isDecoding() && this.workPos > 0x1000) {
    // Flush the remaining decoded bytes
    var output = new Buffer(this.workPos - 0x1000)
    this.workBuffer.copy(output, 0, 0x1000, this.workPos)
    this.push(output)
  }

  if (this.isDecoding() && this.state != STATE_TERMINATED) {
    this.inBuffer = null
    this.workBuffer = null
    return done(new Error('Unexpected end of input'))
  }

  this.inBuffer = null
  this.workBuffer = null
  done()
}

Decoder.prototype.readHeader = function(block) {
  this.inBuffer = this.inBuffer ? Buffer.concat([ this.inBuffer, block ]) : block
  if (this.inBuffer.length < 3) {
    return
  }

  this.compressionType = this.inBuffer.readUInt8(0)
  this.dictionarySizeBits = this.inBuffer.readUInt8(1)
  this.bitBuffer = this.inBuffer.readUInt8(2)
  this.extraBits = 0
  this.dictionarySizeMask = 0xFFFF >> (0x10 - this.dictionarySizeBits)

  if (this.compressionType != CT_BINARY && this.compressionType != CT_ASCII) {
    this.emit('error', new Error('Unsupported compression type: ' + this.compressionType))
    this.state = STATE_ERROR
    return
  }
  if (this.dictionarySizeBits < 4 || this.dictionarySizeBits > 6) {
    this.emit('error', new Error('Unsupported dictionary size: ' + this.dictionarySizeBits))
    this.state = STATE_ERROR
    return
  }

  if (this.compressionType == CT_ASCII) {
    this.generateAsciiTables()
  }

  this.state = STATE_DECODE
  this.inPos = 3
  this.singleLiteralState =
      this.compressionType == CT_BINARY ? STATE_BINARY_LITERAL : STATE_ASCII_LITERAL
  // TODO(tec27): I'm fairly certain this buffer can be sized down (or at the very least, handled
  // differently to avoid copying a lot of data around in it)
  this.workBuffer = new Buffer(0x2203)
  this.workPos = 0x1000
}

var DECODE_FUNCS = []
DECODE_FUNCS[STATE_DECODE] = 'decodeInitial'

DECODE_FUNCS[STATE_REPEATED_LITERAL] = 'decodeRepeatedLiteral'
DECODE_FUNCS[STATE_REPEATED_EXTRA_LENGTH] = 'decodeRepeatedExtraLength'

DECODE_FUNCS[STATE_BINARY_LITERAL] = 'decodeBinaryLiteral'

DECODE_FUNCS[STATE_ASCII_LITERAL] = 'decodeAsciiLiteral'
DECODE_FUNCS[STATE_ASCII_INTERPRET_RESULT] = 'interpretAsciiResult'

DECODE_FUNCS[STATE_INTERPRET_REPEATED_LITERAL] = 'interpretRepeatedLiteral'
DECODE_FUNCS[STATE_GET_DISTANCE_BITS] = 'getDistanceBits'
DECODE_FUNCS[STATE_WRITE_REPEATED_LITERAL] = 'writeRepeatedLiteral'

DECODE_FUNCS[STATE_WRITE_SINGLE_LITERAL] = 'writeSingleLiteral'

Decoder.prototype.next = function() {
  this[DECODE_FUNCS[this.state]]()
}

Decoder.prototype.decode = function() {
  while (this.state < STATE_TERMINATED && !this.awaitingData) {
    this.next()
  }
}

Decoder.prototype.literalDone = function(lit) {
  this.state = lit >= 0x100 ? STATE_INTERPRET_REPEATED_LITERAL : STATE_WRITE_SINGLE_LITERAL
  this.stateStore.decoded = lit
}

Decoder.prototype.decodeInitial = function() {
  var newState = this.bitBuffer & 1 ? STATE_REPEATED_LITERAL : this.singleLiteralState
  if (this.readBits(1)) {
    this.state = newState
    this.next()
  }
}

Decoder.prototype.decodeRepeatedLiteral = function() {
  // The next 8 bits hold the index to the length code table
  var lengthCode = this.lengthCodes[this.bitBuffer & 0xFF]
  var couldRead = this.readBits(lenBits[lengthCode])
  if (!couldRead) {
    return
  }

  // Check if there are some extra bits for this length code
  var extraLengthBits = exLenBits[lengthCode]
  if (extraLengthBits) {
    this.state = STATE_REPEATED_EXTRA_LENGTH
    this.stateStore.lengthCode = lengthCode
    this.next()
  } else {
    this.literalDone(lengthCode + 0x100)
  }
}

Decoder.prototype.decodeRepeatedExtraLength = function() {
  var extraLengthBits = exLenBits[this.stateStore.lengthCode]
    , extraLength = this.bitBuffer & ((1 << extraLengthBits) - 1)
  if (!this.readBits(extraLengthBits)) {
    if (this.stateStore.lengthCode + extraLength != END_MARKER) {
      return
    } else {
      this.awaitingData = false
      this.state = STATE_TERMINATED
      return
    }
  }

  var code = lenBase[this.stateStore.lengthCode] + extraLength
  this.literalDone(code + 0x100)
  this.next()
}

Decoder.prototype.decodeBinaryLiteral = function() {
  var result = this.bitBuffer
  if (this.readBits(8)) {
    this.literalDone(result & 0xFF)
    this.next()
  }
}

Decoder.prototype.decodeAsciiLiteral = function() {
  var result
    , numBits
    , mask
    , table

  if (this.bitBuffer & 0xFF) {
    result = this.asciiTable2C34[this.bitBuffer & 0xFF]
    if (result == 0xFF) {
      var _3F = this.bitBuffer & 0x3F
      numBits = _3F ? 4 : 6
      mask = _3F ? 0xFF : 0x7F
      table = _3F ? this.asciiTable2D34 : this.asciiTable2E34
    } else {
      if (this.readBits(chBitsAsc[result])) {
        this.literalDone(result)
        this.next()
      }
      return
    }
  } else {
    numBits = 8
    mask = 0xFF
    table = this.asciiTable2EB4
  }

  if (!this.readBits(numBits)) {
    return
  }

  this.state = STATE_ASCII_INTERPRET_RESULT
  this.stateStore.asciiResult = table[this.bitBuffer & mask]
  this.next()
}

Decoder.prototype.interpretAsciiResult = function() {
  if (!this.readBits(chBitsAsc[this.stateStore.asciiResult])) {
    return
  }
  this.literalDone(this.stateStore.asciiResult)
  this.next()
}

Decoder.prototype.interpretRepeatedLiteral = function() {
  var nextLiteral = this.stateStore.decoded
  // literal of 0x100 means repeating sequence of 0x2 bytes
  // literal of 0x101 means repeating  sequence of 0x3 bytes
  // ...
  // literal of 0x304 means repeating sequence of 0x206 bytes
  var repetitionLength = nextLiteral - 0xFE
  // decode the distance
  var distPosCode = this.distPosCodes[this.bitBuffer & 0xFF]
    , distPosBits = distBits[distPosCode]

  if (!this.readBits(distPosBits)) {
    return
  }

  this.state = STATE_GET_DISTANCE_BITS
  this.stateStore.repetitionLength = repetitionLength
  this.stateStore.distPosCode = distPosCode
  this.next()
}

Decoder.prototype.getDistanceBits = function() {
  var distPosCode = this.stateStore.distPosCode
    , repLength = this.stateStore.repetitionLength
    , distance
    , bits

  if (repLength == 2) {
    // If the repetition is only 2 bytes in length, then take 2 bits from the stream in order to
    // get the distance
    distance = (distPosCode << 2) | (this.bitBuffer & 0x03)
    bits = 2
  } else {
    // If the repetition is more than 2 bytes in length, then take dictionarySizeBits bits in order
    // to get the distance
    distance = (distPosCode << this.dictionarySizeBits) | (this.bitBuffer & this.dictionarySizeMask)
    bits = this.dictionarySizeBits
  }

  if (this.readBits(bits)) {
    this.state = STATE_WRITE_REPEATED_LITERAL
    this.stateStore.distance = distance + 1
    this.next()
  }
}

Decoder.prototype.writeRepeatedLiteral = function() {
  var distance = this.stateStore.distance
    , src = this.workPos - distance

  this.workBuffer.copy(this.workBuffer, this.workPos, src, src + this.stateStore.repetitionLength)
  this.workPos += this.stateStore.repetitionLength
  this.maybeOutput()
  this.state = STATE_DECODE
}

Decoder.prototype.writeSingleLiteral = function() {
  this.workBuffer[this.workPos] = this.stateStore.decoded
  this.workPos++
  this.maybeOutput()
  this.state = STATE_DECODE
}

Decoder.prototype.maybeOutput = function() {
  if (this.workPos < 0x2000) {
    return
  }

  // Output the 0x1000 bytes we've decoded
  var output = new Buffer(0x1000)
  this.workBuffer.copy(output, 0, 0x1000, 0x2000)
  this.push(output)
  // Copy the decoded data back around to the first half of the buffer, needed because the
  // decoding might reuse some of them as repetitions. Note that if the buffer overflowed
  // previously (into the 0x200ish-odd byte section at the end), the extra data will now be in
  // the "active" area of the buffer, ready to be output when the next flush happens
  this.workBuffer.copy(this.workBuffer, 0, 0x1000, this.workPos)
  this.workPos -= 0x1000
}

// Reads a number of new bits into the bit buffer, discarding old bits in the
// process. New bytes will be read onto the high side of the buffer from the
// current block as needed. This function assumes numBits <= 8
Decoder.prototype.readBits = function(numBits) {
  if (numBits <= this.extraBits) {
    // we already have enough bits in the bit buffer, just shift
    this.extraBits -= numBits
    this.bitBuffer >>= numBits
    return true
  }


  if (this.inPos == this.inBuffer.length) {
    // We don't have enough data in this block to fill the necessary bits
    // Return that we're awaiting data, and don't modify the bitBuffer at this time
    this.awaitingData = true
    return false
  }

  // Place the new byte in the second byte of the bitBuffer
  this.bitBuffer |= this.inBuffer[this.inPos] << (8 + this.extraBits)
  this.inPos++
  // Remove the used bits
  this.bitBuffer >>= numBits
  this.extraBits += 8 - numBits
  return true
}

Decoder.prototype.generateAsciiTables = function() {
  if (!Decoder.asciiTable2C34) {
    genAsciiTables()
  }

  this.asciiTable2C34 = Decoder.asciiTable2C34;
  this.asciiTable2D34 = Decoder.asciiTable2D34;
  this.asciiTable2E34 = Decoder.asciiTable2E34;
  this.asciiTable2EB4 = Decoder.asciiTable2EB4;
}

function genDecodeTables(startIndexes, lengthBits) {
  var result = []

  var i, j, length
  for (i = 0; i < startIndexes.length; i++) {
    length = 1 << lengthBits[i]
    for (j = startIndexes[i]; j < 0x100; j+= length) {
      result[j] = i
    }
  }

  return result
}

function genAsciiTables() {
  Decoder.asciiTable2C34 = []
  Decoder.asciiTable2D34 = []
  Decoder.asciiTable2E34 = []
  Decoder.asciiTable2EB4 = []

  var codeIndex = 0xFF
    , acc
    , add
    , count
  for (count = 0x00FF; codeIndex >= 0; codeIndex--, count--) {
    var bitsIndex = count
      , bitsValue = chBitsAsc[bitsIndex]
    if (bitsValue <= 8) {
      add = 1 << bitsValue
      acc = chCodeAsc[codeIndex]

      do {
        Decoder.asciiTable2C34[acc] = count
        acc += add
      } while (acc < 0x100)
    } else if ((acc = chCodeAsc[codeIndex] & 0xFF)) {
      Decoder.asciiTable2C34[acc] = 0xFF

      if (chCodeAsc[codeIndex] & 0x3F) {
        bitsValue -= 4
        chBitsAsc[bitsIndex] = bitsValue

        add = 1 << bitsValue
        acc = chCodeAsc[codeIndex] >> 4
        do {
          Decoder.asciiTable2D34[acc] = count
          acc += add
        } while (acc < 0x100)
      } else {
        bitsValue -= 6
        chBitsAsc[bitsIndex] = bitsValue

        add = 1 << bitsValue
        acc = chCodeAsc[codeIndex] >> 6
        do {
          Decoder.asciiTable2E34[acc] = count
          acc += add
        } while (acc < 0x80)
      }
    } else {
      bitsValue -= 8
      chBitsAsc[bitsIndex] = bitsValue

      add = 1 << bitsValue
      acc = chCodeAsc[codeIndex] >> 8
      do {
        Decoder.asciiTable2EB4[acc] = count
        acc += add
      } while (acc < 0x100)
    }
  }
}

var distBits = [
  0x02, 0x04, 0x04, 0x05, 0x05, 0x05, 0x05, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06,
  0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
  0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
  0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08
]

var distCode = [
  0x03, 0x0D, 0x05, 0x19, 0x09, 0x11, 0x01, 0x3E, 0x1E, 0x2E, 0x0E, 0x36, 0x16, 0x26, 0x06, 0x3A,
  0x1A, 0x2A, 0x0A, 0x32, 0x12, 0x22, 0x42, 0x02, 0x7C, 0x3C, 0x5C, 0x1C, 0x6C, 0x2C, 0x4C, 0x0C,
  0x74, 0x34, 0x54, 0x14, 0x64, 0x24, 0x44, 0x04, 0x78, 0x38, 0x58, 0x18, 0x68, 0x28, 0x48, 0x08,
  0xF0, 0x70, 0xB0, 0x30, 0xD0, 0x50, 0x90, 0x10, 0xE0, 0x60, 0xA0, 0x20, 0xC0, 0x40, 0x80, 0x00
]

var exLenBits = [
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08
]

var lenBase = [
  0x0000, 0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007,
  0x0008, 0x000A, 0x000E, 0x0016, 0x0026, 0x0046, 0x0086, 0x0106
]

var lenBits = [
  0x03, 0x02, 0x03, 0x03, 0x04, 0x04, 0x04, 0x05, 0x05, 0x05, 0x05, 0x06, 0x06, 0x06, 0x07, 0x07
]

var lenCode = [
  0x05, 0x03, 0x01, 0x06, 0x0A, 0x02, 0x0C, 0x14, 0x04, 0x18, 0x08, 0x30, 0x10, 0x20, 0x40, 0x00
]

var chBitsAsc = [
  0x0B, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x08, 0x07, 0x0C, 0x0C, 0x07, 0x0C, 0x0C,
  0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0D, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C,
  0x04, 0x0A, 0x08, 0x0C, 0x0A, 0x0C, 0x0A, 0x08, 0x07, 0x07, 0x08, 0x09, 0x07, 0x06, 0x07, 0x08,
  0x07, 0x06, 0x07, 0x07, 0x07, 0x07, 0x08, 0x07, 0x07, 0x08, 0x08, 0x0C, 0x0B, 0x07, 0x09, 0x0B,
  0x0C, 0x06, 0x07, 0x06, 0x06, 0x05, 0x07, 0x08, 0x08, 0x06, 0x0B, 0x09, 0x06, 0x07, 0x06, 0x06,
  0x07, 0x0B, 0x06, 0x06, 0x06, 0x07, 0x09, 0x08, 0x09, 0x09, 0x0B, 0x08, 0x0B, 0x09, 0x0C, 0x08,
  0x0C, 0x05, 0x06, 0x06, 0x06, 0x05, 0x06, 0x06, 0x06, 0x05, 0x0B, 0x07, 0x05, 0x06, 0x05, 0x05,
  0x06, 0x0A, 0x05, 0x05, 0x05, 0x05, 0x08, 0x07, 0x08, 0x08, 0x0A, 0x0B, 0x0B, 0x0C, 0x0C, 0x0C,
  0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D,
  0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D,
  0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D,
  0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C,
  0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C,
  0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C,
  0x0D, 0x0C, 0x0D, 0x0D, 0x0D, 0x0C, 0x0D, 0x0D, 0x0D, 0x0C, 0x0D, 0x0D, 0x0D, 0x0D, 0x0C, 0x0D,
  0x0D, 0x0D, 0x0C, 0x0C, 0x0C, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D
]

var chCodeAsc = [
  0x0490, 0x0FE0, 0x07E0, 0x0BE0, 0x03E0, 0x0DE0, 0x05E0, 0x09E0,
  0x01E0, 0x00B8, 0x0062, 0x0EE0, 0x06E0, 0x0022, 0x0AE0, 0x02E0,
  0x0CE0, 0x04E0, 0x08E0, 0x00E0, 0x0F60, 0x0760, 0x0B60, 0x0360,
  0x0D60, 0x0560, 0x1240, 0x0960, 0x0160, 0x0E60, 0x0660, 0x0A60,
  0x000F, 0x0250, 0x0038, 0x0260, 0x0050, 0x0C60, 0x0390, 0x00D8,
  0x0042, 0x0002, 0x0058, 0x01B0, 0x007C, 0x0029, 0x003C, 0x0098,
  0x005C, 0x0009, 0x001C, 0x006C, 0x002C, 0x004C, 0x0018, 0x000C,
  0x0074, 0x00E8, 0x0068, 0x0460, 0x0090, 0x0034, 0x00B0, 0x0710,
  0x0860, 0x0031, 0x0054, 0x0011, 0x0021, 0x0017, 0x0014, 0x00A8,
  0x0028, 0x0001, 0x0310, 0x0130, 0x003E, 0x0064, 0x001E, 0x002E,
  0x0024, 0x0510, 0x000E, 0x0036, 0x0016, 0x0044, 0x0030, 0x00C8,
  0x01D0, 0x00D0, 0x0110, 0x0048, 0x0610, 0x0150, 0x0060, 0x0088,
  0x0FA0, 0x0007, 0x0026, 0x0006, 0x003A, 0x001B, 0x001A, 0x002A,
  0x000A, 0x000B, 0x0210, 0x0004, 0x0013, 0x0032, 0x0003, 0x001D,
  0x0012, 0x0190, 0x000D, 0x0015, 0x0005, 0x0019, 0x0008, 0x0078,
  0x00F0, 0x0070, 0x0290, 0x0410, 0x0010, 0x07A0, 0x0BA0, 0x03A0,
  0x0240, 0x1C40, 0x0C40, 0x1440, 0x0440, 0x1840, 0x0840, 0x1040,
  0x0040, 0x1F80, 0x0F80, 0x1780, 0x0780, 0x1B80, 0x0B80, 0x1380,
  0x0380, 0x1D80, 0x0D80, 0x1580, 0x0580, 0x1980, 0x0980, 0x1180,
  0x0180, 0x1E80, 0x0E80, 0x1680, 0x0680, 0x1A80, 0x0A80, 0x1280,
  0x0280, 0x1C80, 0x0C80, 0x1480, 0x0480, 0x1880, 0x0880, 0x1080,
  0x0080, 0x1F00, 0x0F00, 0x1700, 0x0700, 0x1B00, 0x0B00, 0x1300,
  0x0DA0, 0x05A0, 0x09A0, 0x01A0, 0x0EA0, 0x06A0, 0x0AA0, 0x02A0,
  0x0CA0, 0x04A0, 0x08A0, 0x00A0, 0x0F20, 0x0720, 0x0B20, 0x0320,
  0x0D20, 0x0520, 0x0920, 0x0120, 0x0E20, 0x0620, 0x0A20, 0x0220,
  0x0C20, 0x0420, 0x0820, 0x0020, 0x0FC0, 0x07C0, 0x0BC0, 0x03C0,
  0x0DC0, 0x05C0, 0x09C0, 0x01C0, 0x0EC0, 0x06C0, 0x0AC0, 0x02C0,
  0x0CC0, 0x04C0, 0x08C0, 0x00C0, 0x0F40, 0x0740, 0x0B40, 0x0340,
  0x0300, 0x0D40, 0x1D00, 0x0D00, 0x1500, 0x0540, 0x0500, 0x1900,
  0x0900, 0x0940, 0x1100, 0x0100, 0x1E00, 0x0E00, 0x0140, 0x1600,
  0x0600, 0x1A00, 0x0E40, 0x0640, 0x0A40, 0x0A00, 0x1200, 0x0200,
  0x1C00, 0x0C00, 0x1400, 0x0400, 0x1800, 0x0800, 0x1000, 0x0000
]

module.exports = createDecoderStream
