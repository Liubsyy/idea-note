// 打包体积优化:替代 elkjs/lib/elk.bundled.js(约 1.4MB)。
//
// mermaid 只有渲染 `flowchart-elk` 类型图表时才会用到 ELK 布局引擎,普通
// flowchart/graph 走 dagre,不经过这里。stub 让 elk 图表在渲染时报一个可读的
// 错误(由 diagram.ts 的 catch 显示),而不是把整个引擎打进安装包。
// 若以后需要 elk 图表,删掉 vite.config.ts 里的 resolve.alias 即可恢复。
export default class ELKStub {
  layout(): Promise<never> {
    return Promise.reject(
      new Error("flowchart-elk 布局已在打包时移除,请改用普通 flowchart"),
    );
  }
}
