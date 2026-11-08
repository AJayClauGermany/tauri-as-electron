// Renderer code: only talks to the main process through `window.api`
// (exposed by src/preload.js), just like a context-isolated Electron app.
const $ = (selector) => document.querySelector(selector)

window.api.versions().then((versions) => {
  $('#versions').textContent = JSON.stringify(versions, null, 2)
})

$('#title-form').addEventListener('submit', (event) => {
  event.preventDefault()
  window.api.setTitle($('#title').value)
})

$('#ping').addEventListener('click', async () => {
  $('#pong').textContent = await window.api.ping(new Date().toLocaleTimeString())
})

window.api.onHello((message) => {
  $('#from-main').textContent = message
})
