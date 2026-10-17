// [leo] 主进程先建临时 HOME 并写进 process.env，worker 继承同一个目录。
import { isolateTestHome } from "./home.mjs";

export default function setup() {
  isolateTestHome();
}
