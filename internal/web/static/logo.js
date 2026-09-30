"use strict";

// 两个布局共用一个控制器；换 URL 的片段使 <img> 的 SVG 时间轴从头开始。
const atriumLogo = (() => {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const slots = [...document.querySelectorAll("[data-atrium-logo]")];
  slots.forEach(slot => {
    slot.innerHTML = '<img src="/ui/assets/logo.svg" alt=""><span class="logo-status" role="status" hidden>重连中</span>';
  });
  let reconnecting = false, timer, replay = 0, shippedID;
  const assets = {};
  // 断线后服务无法提供文件，提前把两份动画留在页面内（约 13 KB）。
  const ready = Promise.all(["enter", "run"].map(async mode => {
    const response = await fetch(`/ui/assets/logo-${mode}-20.svg`);
    if (!response.ok) throw new Error("logo 读取失败");
    assets[mode] = URL.createObjectURL(await response.blob());
  }));
  function show(mode) {
    clearTimeout(timer);
    if (motion.matches || (mode !== "static" && !assets[mode])) mode = "static";
    const src = mode === "static" ? "/ui/assets/logo.svg" : `${assets[mode]}#${++replay}`;
    slots.forEach(slot => {
      const img = slot.querySelector("img");
      img.onload = mode === "enter" ? () => {
        clearTimeout(timer);
        timer = setTimeout(() => show(reconnecting ? "run" : "static"), 1000);
      } : null;
      img.dataset.mode = mode;
      img.src = src;
    });
  }
  motion.addEventListener("change", () => show(reconnecting ? "run" : "static"));
  ready.then(() => show(reconnecting ? "run" : "enter"));
  return {
    get reconnecting() { return reconnecting; },
    connection(connected) {
      if (reconnecting === !connected) return;
      reconnecting = !connected;
      slots.forEach(slot => { slot.querySelector(".logo-status").hidden = connected; });
      show(connected ? "static" : "run");
    },
    shipped(id) {
      // 首次数据只建立基线；保留最大值，避免较早请求迟到或事件清理后重播。
      if (shippedID !== undefined && id > shippedID && !reconnecting) show("enter");
      shippedID = Math.max(shippedID ?? 0, id);
    },
  };
})();
