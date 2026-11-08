window.kitchen.onChildPing((value) => {
  document.querySelector('#last-ping').textContent = JSON.stringify(value)
  window.kitchen.childPong(value)
})
