declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

/** Markdown 文档按原文内联为字符串，见 rspack.config.ts 的 asset/source 规则 */
declare module '*.md' {
  const source: string
  export default source
}

/** 默认自定义思维链按原文内联，见 rspack.config.ts 的 asset/source 规则 */
declare module '*.txt' {
  const source: string
  export default source
}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}
