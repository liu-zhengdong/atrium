import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import WebSocket from "ws";

const CHROME_PATH =
  "/Users/liuzhengdong/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const WORKTREE = "/Users/liuzhengdong/MyCodeBase/repo/atrium-103-qoder-ui";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function sendCdp(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1000000);
  return new Promise((resolve, reject) => {
    const handleMsg = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.off("message", handleMsg);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      } catch (e) {
        // ignore
      }
    };
    ws.on("message", handleMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function killPort(port) {
  try {
    const out = execSync(`lsof -ti:${port}`, { encoding: "utf8" }).trim();
    if (out) {
      for (const line of out.split("\n")) {
        const pid = parseInt(line.trim(), 10);
        if (pid && !isNaN(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    }
  } catch {}
}

async function main() {
  const tempDir = await fs.mkdtemp("/tmp/atrium-snap-");
  const dataDir = `${tempDir}/data`;
  const piDir = `${tempDir}/pi`;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(`${piDir}/agents`, { recursive: true });

  // 0. 清理旧进程
  killPort(4399);

  const env = {
    ...process.env,
    ATRIUM_DATA: dataDir,
    ATRIUM_PI_HOME: piDir,
    ATRIUM_DESKTOPS: `${tempDir}/desktops`,
    ATRIUM_PORT: "4399",
  };

  // 1. 启动 Atrium（使用非 4310 端口避免与用户本地正在运行的实例冲突）
  console.log(`Starting Atrium with ATRIUM_DATA=${dataDir}...`);
  const atriumProc = spawn("node", ["bin/atrium.mjs", "--no-open"], {
    cwd: WORKTREE,
    env,
    stdio: "pipe",
  });

  let serviceUrl = null;
  atriumProc.stdout.on("data", (d) => {
    const str = d.toString();
    process.stdout.write(str);
    const m = str.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (m) serviceUrl = m[0];
  });
  atriumProc.stderr.on("data", (d) => process.stderr.write(d));

  // 等待 server 就绪
  for (let i = 0; i < 30; i++) {
    if (serviceUrl) {
      try {
        const res = await fetch(`${serviceUrl}/api/overview`);
        if (res.ok) {
          console.log(`Atrium ready at ${serviceUrl}!`);
          break;
        }
      } catch {
        // wait
      }
    }
    await wait(400);
  }

  if (!serviceUrl) throw new Error("Atrium service URL not found");

  // 2. 注入真实业务数据（Agent、群、对话），用于捕获真实视觉产物
  const runCli = (args) =>
    new Promise((resolve, reject) => {
      const p = spawn("node", ["bin/atrium.mjs", ...args], {
        cwd: WORKTREE,
        env,
        stdio: "inherit",
      });
      p.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`CLI exited with ${code}`)),
      );
    });

  try {
    console.log("Seeding test data via CLI...");
    await runCli(["create", "Pilot", "--description", "系统架构师"]);
    await runCli(["create", "Spark", "--description", "前端与体验设计师"]);
    await runCli(["group", "中庭架构重构组", "Pilot", "Spark"]);
    await runCli([
      "send",
      "c1",
      "各位同伴，我们正在为 Atrium 引入 Qoder 森林灰绿风格与工作台布局，请评估下各自的影响。",
    ]);
    await runCli([
      "send",
      "c1",
      "收到！当前整体布局已经重构完成——一体化桌面工作台（Workbench）：各组件通过空间距离产生呼吸与分组感，彻底消除了冗余文字标签与生硬背景色块。",
      "--as",
      "Pilot",
    ]);
    await runCli([
      "send",
      "c1",
      "在宽屏下，侧栏以优雅的 SidePanel 形式并排推开；窄屏下自动切换为抽屉遮罩。",
      "--as",
      "Spark",
    ]);
    console.log("Test data seeded successfully!");
  } catch (e) {
    console.error("Failed to seed CLI data:", e);
  }

  // 3. 启动 Chromium
  const cdpPort = 9222 + Math.floor(Math.random() * 100);
  const chromeProc = spawn(
    CHROME_PATH,
    [
      "--headless=new",
      `--remote-debugging-port=${cdpPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${tempDir}/chrome`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  // 等待 CDP 就绪
  let wsUrl = null;
  for (let i = 0; i < 25; i++) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {
      await wait(300);
    }
  }

  if (!wsUrl) throw new Error("Chrome CDP not ready");

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.on("open", r));

  console.log("CDP connected, configuring retina viewport (1440x900 @ 2x)...");
  await sendCdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });

  await sendCdp(ws, "Page.enable");
  await sendCdp(ws, "Page.navigate", { url: serviceUrl });
  await wait(2500);

  async function snap(name) {
    const res = await sendCdp(ws, "Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.data, "base64");
    const outPath = `${WORKTREE}/docs/screenshots/${name}`;
    await fs.writeFile(outPath, buffer);
    console.log(`Saved screenshot: ${outPath} (${buffer.length} bytes)`);
  }

  // 1. 单人私聊 / 默认对话
  await snap("01-workbench-chat.png");

  // 2. 打开群设置 / 成员面板
  try {
    await sendCdp(ws, "Runtime.evaluate", {
      expression: `(() => {
        const rows = document.querySelectorAll(".group\\\\/row button");
        if (rows.length > 1) rows[1].click();
      })()`,
    });
    await wait(1000);

    await sendCdp(ws, "Runtime.evaluate", {
      expression: `(() => {
        const btn = document.querySelector("button[aria-label='群成员与设置']");
        if (btn) btn.click();
      })()`,
    });
    await wait(1200);
    await snap("02-workbench-split-panel.png");
  } catch (e) {
    console.error("Error snapping split panel:", e);
  }

  // 3. Agent 名册
  try {
    await sendCdp(ws, "Runtime.evaluate", {
      expression: `(() => {
        const navBtns = document.querySelectorAll("nav[aria-label='主导航'] button");
        if (navBtns.length > 1) navBtns[1].click();
      })()`,
    });
    await wait(1200);
    await snap("03-workbench-agent-directory.png");
  } catch (e) {
    console.error("Error snapping agents:", e);
  }

  // 4. 聊天记录
  try {
    await sendCdp(ws, "Runtime.evaluate", {
      expression: `(() => {
        const navBtns = document.querySelectorAll("nav[aria-label='主导航'] button");
        if (navBtns.length > 2) navBtns[2].click();
      })()`,
    });
    await wait(2000);
    await snap("04-workbench-records.png");
  } catch (e) {
    console.error("Error snapping records:", e);
  }

  ws.close();
  chromeProc.kill();
  atriumProc.kill();
  try {
    execSync(`node bin/atrium.mjs stop`, {
      cwd: WORKTREE,
      env,
      stdio: "ignore",
    });
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
  killPort(4399);
  console.log("Done!");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
