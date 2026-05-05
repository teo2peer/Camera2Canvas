"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startService = startService;
exports.stopService = stopService;
const child_process_1 = require("child_process");
const net_1 = __importDefault(require("net"));
const path_1 = __importDefault(require("path"));
let proc = null;
function isPortOpen(port, host = "127.0.0.1", timeoutMs = 400) {
    return new Promise((resolve) => {
        const sock = new net_1.default.Socket();
        let done = false;
        const finish = (v) => { if (done)
            return; done = true; sock.destroy(); resolve(v); };
        sock.setTimeout(timeoutMs);
        sock.once("connect", () => finish(true));
        sock.once("timeout", () => finish(false));
        sock.once("error", () => finish(false));
        sock.connect(port, host);
    });
}
async function startService(rootDir, port = 8765) {
    if (proc)
        return;
    if (await isPortOpen(port)) {
        console.log(`[service] already running on :${port}, skipping spawn`);
        return;
    }
    const py = process.platform === "win32"
        ? path_1.default.join(rootDir, ".venv", "Scripts", "python.exe")
        : path_1.default.join(rootDir, ".venv", "bin", "python");
    proc = (0, child_process_1.spawn)(py, ["-m", "service.main"], {
        cwd: rootDir,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        windowsHide: true,
    });
    proc.on("exit", (code) => {
        console.error(`[service] exited code=${code}`);
        proc = null;
    });
}
function stopService() {
    if (!proc)
        return;
    try {
        if (process.platform === "win32" && proc.pid) {
            // ensure child + descendants die
            const { execSync } = require("child_process");
            try {
                execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
            }
            catch { }
        }
        else {
            proc.kill("SIGTERM");
        }
    }
    catch { }
    proc = null;
}
