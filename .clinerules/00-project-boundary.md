# 项目平台与架构边界

## 当前运行目标

本项目当前实际运行于 Pi / PI WEB。

VS Code 和 Cline 仅用于开发、测试和维护代码，不是本项目的运行平台。

## 强制架构边界

- Pi 是第一版实际宿主，但不是核心依赖。
- 核心业务逻辑必须保持宿主无关。
- Pi Extension 只能作为适配层调用核心。
- 不得把多模型推演逻辑直接写入 Pi Extension。
- 不得把项目实现为 Cline SDK 应用。
- 不得依赖 Cline Agent Teams、Cline 子代理或 Cline 会话完成运行时评议。
- 不得依赖 VS Code Extension API。
- 不得要求最终用户安装 Cline、VS Code 或 OpenCode。
- 后续更换宿主时，应只需新增或替换适配层。

## 第一版目标

第一版最终交付结构为：

1. 独立 TypeScript 核心；
2. 独立 CLI；
3. Pi Extension；
4. Pi Skill。

MCP 和其他宿主适配属于后续阶段。
