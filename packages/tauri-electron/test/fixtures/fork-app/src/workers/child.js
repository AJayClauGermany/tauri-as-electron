// A child_process.fork child: Node's own process.send.
process.on('message', (message) => {
  if (message === 'exit') return process.disconnect()
  process.send({ got: message, argv: process.argv.slice(2), dirname: __dirname, connected: process.connected })
})
process.stdout.write('child started\n')
