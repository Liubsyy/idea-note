window.classicLoaded = true;
document.getElementById('counter').onclick = event => { event.target.textContent = String(Number(event.target.textContent) + 1); };
