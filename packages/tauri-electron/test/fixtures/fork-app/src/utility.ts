// A utility process: replies over process.parentPort and over transferred ports.
import { net } from 'electron'
import { describe } from './shared'

type Message = { type: string; value?: unknown }

const parentPort = (process as any).parentPort

parentPort.on('message', (event: { data: Message; ports: any[] }) => {
  const { data, ports } = event
  if (data.type === 'hello') {
    parentPort.postMessage({
      reply: describe('utility'),
      argv: process.argv.slice(2),
      dirname: __dirname,
      fetch: typeof net.fetch,
      processType: (process as any).type,
      echo: data.value,
    })
  } else if (data.type === 'port') {
    const [port] = ports
    port.on('message', (e: { data: number }) => port.postMessage(e.data * 2))
    port.start()
    parentPort.postMessage({ reply: 'port ready' })
  } else if (data.type === 'exit') {
    process.exit(Number(data.value))
  } else if (data.type === 'electron-app') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron')
    try {
      app.getName()
    } catch (error) {
      parentPort.postMessage({ reply: (error as Error).message })
    }
  }
})
console.log('utility started')
