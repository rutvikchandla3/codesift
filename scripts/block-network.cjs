const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')

function fail(method) {
  throw new Error(`unexpected network egress via ${method}`)
}

http.request = function request() {
  fail('http.request')
}

https.request = function request() {
  fail('https.request')
}

net.connect = function connect() {
  fail('net.connect')
}

net.createConnection = function createConnection() {
  fail('net.createConnection')
}

tls.connect = function connect() {
  fail('tls.connect')
}

globalThis.fetch = async function fetch() {
  fail('fetch')
}
