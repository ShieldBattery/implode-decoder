var test = require('tap').test
  , fs = require('fs')
  , concat = require('concat-stream')

var createDecoder = require('../')

test('decodes files with small dictionaries', function(t) {
  doTest(t, 'small.imploded', 'small.txt')
})

test('decodes files with medium dictionaries', function(t) {
  doTest(t, 'medium.imploded', 'medium.txt')
})

test('decodes files with large dictionaries', function(t) {
  doTest(t, 'large.imploded', 'large.txt')
})

function doTest(t, compressed, uncompressed) {
  var d = createDecoder()
    , actual
    , expected

  t.plan(1)

  fs.createReadStream(compressed).pipe(d).pipe(concat(function(data) {
    actual = data
    checkEq(t, actual, expected)
  }))
  fs.createReadStream(uncompressed).pipe(concat(function(data) {
    expected = data
    checkEq(t, actual, expected)
  }))
}

function checkEq(t, actual, expected) {
  if (!actual || !expected) {
    return
  }

  t.deepEqual(actual, expected)
}
