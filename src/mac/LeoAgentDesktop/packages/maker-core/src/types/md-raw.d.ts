// Vite ?raw 后缀：把任意文件当成原始字符串 import 进来。
// 编译期由 vite 把文件内容内联为字符串字面量，运行时不需要 IO。
declare module '*.md?raw' {
  const content: string;
  export default content;
}
