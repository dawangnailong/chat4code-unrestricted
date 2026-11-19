import type { ShellApi, ToolchainIO } from '../types.js'

/**
 * 按需工具链运行时模块的公共契约。
 *
 * 每个文件导出一个 RuntimeModule：`load` 负责把运行时准备好（下载 / 缓存 / 编译），
 * `run` 负责执行一条命令。除了 python（Pyodide）、node、git 这三个历史实现之外，
 * lua / sqlite / esbuild / make 都走这套接口，registry 只用动态 import 取模块，
 * 所以没安装的运行时不会进首屏包。
 */

export type RuntimeProgress = (progress: number) => void

/** 运行时的执行上下文：ToolchainIO 加上可选的子命令执行（make 用） */
export type RuntimeIO = ToolchainIO & { shell?: ShellApi }

export type RuntimeModule = {
  /** 让运行时可用并返回版本号；失败时抛错，由 registry 转成安装失败原因 */
  load: (onProgress: RuntimeProgress) => Promise<{ version: string }>
  /** 执行命令；argv 不含命令名，输出写 io.stdout / io.stderr */
  run: (argv: string[], io: RuntimeIO) => Promise<{ code: number }>
  /** 卸载时释放内存里的实例（可选） */
  dispose?: () => void | Promise<void>
}
