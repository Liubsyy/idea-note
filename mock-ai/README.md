# AI 测试服务

项目内置了一个无需联网、无需 API Key 的 OpenAI 兼容测试服务，用来快速验证 AI 笔记助手的基础问答界面。

## 启动

在项目根目录运行：

```bash
npm run mock:ai
```

默认监听 `127.0.0.1:11435`。如需修改端口：

```bash
MOCK_AI_PORT=12000 npm run mock:ai
```

## 在 Idea Note 中配置

打开“设置 → AI 笔记助手 → 添加模型”，填写：

- 名称：`本地测试 AI`
- 类型：`OpenAI 兼容`
- Base URL：`http://127.0.0.1:11435/v1`
- API Key：留空
- 模型 ID：`idea-note-test`

保存后，在右侧 AI 面板选择“本地测试 AI”，即可提问。

## 预置问答

- “你好” → 返回测试助手问候语
- “你是谁” → 返回测试助手介绍
- “总结这篇笔记” → 返回固定摘要
- “下一步做什么” → 返回固定行动项
- “谢谢” → 返回固定结束语
- 其他内容 → 返回默认提示

要调整匹配关键词或返回文案，直接编辑 [`responses.json`](./responses.json)。规则按顺序匹配，命中任意一个关键词就返回该条回答。

## 接口

- `GET /health`：健康检查
- `GET /v1/models`：模型列表
- `POST /v1/chat/completions`：聊天接口，同时支持普通 JSON 和 SSE 流式响应

运行测试：

```bash
npm run test:mock-ai
```
