/**
 * 本插件消费的宿主契约的最小类型声明。
 *
 * 为什么自写而不 import：dsh 的 asar 只发布编译后的 JS，package.json 的 types
 * 指向的 lib/types/index.d.ts 并不随包分发，装不到 @deepseek-ai/dsh-tools 的类型。
 * 这里只声明本项目真正用到的那部分，保持零运行时依赖、离线可编译。
 */
export {};
