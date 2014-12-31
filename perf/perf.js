var fs = require('fs')
  , createDecoder = require('../')
  , concat = require('concat-stream')
  , spigot = require('stream-spigot')
  , prettyHrtime = require('pretty-hrtime')

var buf = fs.readFileSync(__dirname + '/perftest.imploded')

var i = 0
  , times = []

function createStream() {
  var uncalled = true
  return spigot.sync(function() {
    if (uncalled) {
      uncalled = false
      return buf
    }
  })
}

function test() {
  var t = process.hrtime()
  createStream().pipe(createDecoder()).pipe(concat(function(data) {
    times.push(process.hrtime(t))
    if (++i < 51) {
      test()
    } else {
      printMedian()
    }
  }))
}

function printMedian() {
  times.sort(function(a, b) {
    if (a[0] === b[0]) {
      return a[1] - b[1]
    }

    return a[0] - b[0]
  })

  var median = Math.round((times.length - 1) / 2)
  console.log('median: ' + prettyHrtime(times[median], {precise: true}))
}

test()
