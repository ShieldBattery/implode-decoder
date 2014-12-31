# implode-decoder
A pure JavaScript decoder for the PKWare implode compression algorithm.

[![Build Status](https://img.shields.io/travis/tec27/implode-decoder.png?style=flat)](https://travis-ci.org/tec27/implode-decoder)
[![NPM](https://img.shields.io/npm/v/implode-decoder.svg?style=flat)](https://www.npmjs.org/package/implode-decoder)

[![NPM](https://nodei.co/npm/implode-decoder.png)](https://www.npmjs.org/package/implode-decoder)

Note that this is **not** the same implode algorithm as used in PKZip (compression method 6), but
rather a standalone one that was often used in 90s-era games (e.g. StarCraft, Diablo). I believe
these algorithms are similar, but at the very least the header formats differ.

Implementation is inspired by [StormLib's explode.c](https://github.com/ladislav-zezula/StormLib/blob/master/src%2Fpklib%2Fexplode.c).

## Usage
The only exported function in this module is a function to create a streams2 Transform stream. You
may use the resulting stream as you would any other Transform stream.

```javascript
var decodeImplode = require('implode-decoder')
  , fs = require('fs')

fs.createReadStream('myFile.example')
  .pipe(decodeImplode())
  .pipe(fs.createWriteStream('decompressed'))
```

## Performance
A simple performance test of a "large" imploded file is included in the `perf/` directory. I've run
this test alongside an analagous test written in C using StormLib, with the following results:

**StormLib:** `median: 4.468634 ms`

**implode-decoder:** `median: 4.314142 ms`

Performance characteristics should be relatively similar to StormLib's implementation, although this
version supports fully streaming data input, so is a bit more flexible (StormLib's operates on a
"pull"-type interface, and expects to have access to data when it needs it).

## LICENSE
MIT
