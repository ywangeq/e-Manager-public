import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeLocalInstallation } from "./local-install.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = initializeLocalInstallation(path.join(root, "data", "local"), { password: process.env.EMANAGER_LOCAL_PASSWORD });
console.log(result.created ? "本地账号已初始化：admin@localhost" : "已有本地账号，密码和数据未改变。");
if (result.passwordFile) console.log(`首次登录密码保存在：${result.passwordFile}`);
console.log("运行 pnpm start 启动本地 Center。");
