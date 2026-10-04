export function progressMessage(count) {
  if (count === 0) return "准备好了，就从第一项开始吧。";
  if (count < 3) return "已经迈出一步，继续按自己的节奏来。";
  return "今天的进展不错，记得休息一下。";
}
