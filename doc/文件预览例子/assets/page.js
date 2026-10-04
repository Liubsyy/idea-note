import { progressMessage } from "./messages.js";

let count = 0;
function render() {
  document.getElementById("count").textContent = String(count);
  document.getElementById("message").textContent = progressMessage(count);
}
document.getElementById("increment").addEventListener("click", () => {
  count += 1;
  render();
});
document.getElementById("reset").addEventListener("click", () => {
  count = 0;
  render();
});
document.getElementById("module-status").textContent = "✓ ES 模块与相对导入";
render();
