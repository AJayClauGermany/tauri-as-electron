window.kitchen.onChildPing((value) => {
  document.querySelector('#last-ping').textContent = JSON.stringify(value)
  window.kitchen.childPong(value)
})

// Frameless demo (opened by the "Frameless window" manual check).
if (new URLSearchParams(location.search).get('frameless') === '1') {
  document.body.classList.add('frameless')
  const bar = document.createElement('header')
  bar.className = 'titlebar'
  bar.innerHTML = '<span>Drag me (-webkit-app-region: drag)</span><button type="button">Close</button>'
  bar.querySelector('button').addEventListener('click', () => window.close())
  document.body.prepend(bar)
  const drop = document.createElement('p')
  drop.textContent = 'Drop files here.'
  document.body.append(drop)
  window.addEventListener('dragover', (event) => event.preventDefault())
  window.addEventListener('drop', (event) => {
    event.preventDefault()
    const files = [...(event.dataTransfer?.files ?? [])]
    drop.textContent = files.map((file) => window.kitchen.pathForFile(file) || file.name).join('\n') || 'No files'
  })
}
