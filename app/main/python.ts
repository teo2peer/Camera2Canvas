import { spawn, ChildProcess } from "child_process";
import net from "net";
import path from "path";

let proc: ChildProcess | null = null;

function isPortOpen(port: number, host = "127.0.0.1", timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

export async function startService(rootDir: string, port = 8765) {
  if (proc) return;
  if (await isPortOpen(port)) {
    console.log(`[service] already running on :${port}, skipping spawn`);
    return;
  }
  const py = process.platform === "win32"
    ? path.join(rootDir, ".venv", "Scripts", "python.exe")
    : path.join(rootDir, ".venv", "bin", "python");
  proc = spawn(py, ["-m", "service.main"], {
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

export function stopService() {
  if (!proc) return;
  try {
    if (process.platform === "win32" && proc.pid) {
      // ensure child + descendants die
      const { execSync } = require("child_process");
      try { execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" }); } catch {}
    } else {
      proc.kill("SIGTERM");
    }
  } catch {}
  proc = null;
}
