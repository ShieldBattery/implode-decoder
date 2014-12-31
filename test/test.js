var test = require('tape').test
  , fs = require('fs')
  , concat = require('concat-stream')
  , through = require('through2')

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

test('decodes files that were ASCII compressed', function(t) {
  doTest(t, 'large.imploded.ascii', 'large.txt')
})

test('decodes files when buffers are split up', function(t) {
  var d = createDecoder()
    , actual
    , expected

  t.plan(1)

  fs.createReadStream(__dirname + '/medium.imploded').pipe(through(function(block, enc, done) {
    // be super-adversarial with reading: every byte in a separate buffer
    for (var i = 0; i < block.length; i++) {
      this.push(block.slice(i, i + 1))
    }
    done()
  })).pipe(d).pipe(concat(function(data) {
    actual = data
    checkEq(t, actual, expected)
  })).on('error' ,function(err) {
    t.fail('decoding error: ' + err)
  })

  fs.createReadStream(__dirname + '/medium.txt').pipe(concat(function(data) {
    expected = data
    checkEq(t, actual, expected)
  }))
})

function doTest(t, compressed, uncompressed) {
  var d = createDecoder()
    , actual
    , expected

  t.plan(1)

  fs.createReadStream(__dirname + '/' + compressed).pipe(d).pipe(concat(function(data) {
    actual = data
    checkEq(t, actual, expected)
  })).on('error', function(err) {
    t.fail('decoding error: ' + err)
  })
  fs.createReadStream(__dirname + '/' + uncompressed).pipe(concat(function(data) {
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
