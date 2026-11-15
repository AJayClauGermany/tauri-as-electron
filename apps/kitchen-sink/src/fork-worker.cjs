// Started by checks-wave-c-fork.js as a utility process (process.parentPort)
// and with child_process.fork (process.send). Plain Node.js code: it runs
// unchanged on Electron and on Tauri, where tauri-electron's bundler plugin
// finds it as a fork entry point and builds it for Node.js.
const path = require('node:path')

function handle(message, reply, ports = []) {
  switch (message?.type) {
    case 'hello':
      return reply({
        pong: message.value,
        argv: process.argv.slice(2),
        dirname: path.basename(__dirname),
        node: process.versions.node,
        utility: Boolean(process.parentPort),
        env: process.env.KITCHEN_FORK_ENV ?? null,
      })
    case 'port': {
      const [port] = ports
      port.on('message', (event) => port.postMessage({ doubled: event.data * 2 }))
      port.start()
      return reply({ ready: true })
    }
    case 'stdout':
      process.stdout.write(`${message.value}\n`)
      return reply({ written: true })
    case 'electron': {
      let net
      try {
        net = typeof require('electron').net?.fetch
      } catch (error) {
        net = `error: ${error.message}`
      }
      return reply({ net })
    }
    case 'exit':
      return process.exit(message.code)
  }
}

if (process.parentPort) {
  process.parentPort.on('message', (event) => handle(event.data, (value) => process.parentPort.postMessage(value), event.ports))
} else if (process.send) {
  process.on('message', (message) => {
    if (message?.type === 'disconnect') return process.disconnect()
    handle(message, (value) => process.send(value))
  })
}
