import { value } from './value.js';
addEventListener('load', () => {
  const button = document.getElementById('counter');
  button.click();
  let parentBlocked = false;
  try { void parent.document.body; } catch { parentBlocked = true; }
  parent.postMessage({ type:'preview-fixture', value, classic:window.classicLoaded,
    count:button.textContent, color:getComputedStyle(document.querySelector('h1')).color,
    image:document.getElementById('icon').naturalWidth, parentBlocked,
    nativeExposed:typeof window.__TAURI_INTERNALS__ !== 'undefined' }, '*');
});
