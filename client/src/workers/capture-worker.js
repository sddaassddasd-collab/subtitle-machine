import {io} from 'socket.io-client'
import {CapturePipeline} from '../lib/capture-pipeline.js'

let pipeline, port
self.onmessage = ({data}) => {
  if (data.type === 'start') {
    pipeline?.stop(); port?.close()
    pipeline = new CapturePipeline({
      createSocket: () => io(data.config.origin, {forceNew: true, autoConnect: false,
        transports: ['websocket'], reconnection: false}),
      notify: event => self.postMessage(event),
    })
    port = data.port
    port.onmessage = event => pipeline.receive(event.data)
    pipeline.start(data.config)
  } else if (data.type === 'clock') pipeline?.setClock(data.clock)
  else if (data.type === 'control') pipeline?.setControlSocketId(data.controlSocketId)
  else if (data.type === 'recover') pipeline?.recover(data.reason, data.scope)
  else if (data.type === 'stop') {pipeline?.stop(data); port?.close(); self.close()}
}
