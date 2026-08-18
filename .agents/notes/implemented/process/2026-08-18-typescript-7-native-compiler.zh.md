# Agent Note: 使用 TypeScript 6 API 兼容层的 TypeScript 7 编译器

Status: implemented

English | [English](2026-08-18-typescript-7-native-compiler.md)

## Problem

仓库需要使用 TypeScript 7 原生编译器执行 Project Reference 构建，但 Typert、仓库生成器和校验脚本仍然导入 TypeScript 编译器 API。TypeScript 7.0 提供 `tsc` 可执行文件，但不提供这些消费者所需的程序化 API。

## Decision

根 workspace 通过 `@typescript/native` npm alias 使用 TypeScript 7.0.2，同时将 `typescript` 依赖设置为现有 6.0 系列的 `@typescript/typescript6` 兼容包。因此，从 `typescript` 导入的代码继续使用 TypeScript 6 API，而根构建和类型检查脚本使用的 `tsc` 来自 TypeScript 7。只需要编译器的包直接使用 TypeScript 7；`@deepseek-ai/dsh-typert-generator` 会在运行时执行编译器 API，因此保留 TypeScript 6 兼容依赖。TypeScript peer 允许的版本范围覆盖两条编译器线路。

共享 base 在会影响仓库的地方显式设置 TypeScript 7 的默认值变化：设置 `noUncheckedSideEffectImports` 和 `libReplacement`；包项目已经设置 `rootDir`；生成器 fixture 不再使用已移除的 `baseUrl` 和 `ignoreDeprecations` 选项。

## Alternatives considered

**将所有 TypeScript API 消费者替换为兼容 TypeScript 7 的工具。** 不采用，因为 TypeScript 7.0 没有程序化 API，而仓库的 Typert 和语义门禁依赖现有 API；替换它们会使变更范围超出编译器升级。

**继续只使用 TypeScript 6 作为编译器。** 不采用，因为这不会交付所请求的 TypeScript 7 编译器及其原生 Project Reference 构建。

**让 `typescript` 包名指向 TypeScript 7，再将 API 导入移动到单独模块。** 不采用，因为兼容包正是为了让尚未采用 TypeScript 7 API 的工具继续解析直接的 `typescript` peer 和导入。

## Consequences

构建和类型检查使用 TypeScript 7 原生可执行文件，而编译器 API 消费者在 TypeScript 7 API 可用前继续使用 TypeScript 6 兼容实现。两个版本会有意并行安装，因此依赖和 peer 更新必须保留这两个角色。TypeScript 7 编译器诊断以及仓库现有的运行时测试仍然是此次迁移所需的证据。
