const FIRST_CHECK_DELAY_MS = 8_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export function createAutoUpdateController({ updater, dialog, notify, setTimeoutFn = setTimeout, setIntervalFn = setInterval }) {
  const reportError = () => notify({ state: "error", message: "暂时无法检查更新，不影响继续使用。" });
  const check = async () => {
    notify({ state: "checking", message: "正在检查部署器更新…" });
    try { await updater.checkForUpdates(); } catch { reportError(); }
  };

  function start({ isPackaged, smokeTest }) {
    if (!isPackaged || smokeTest) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.on("update-not-available", () => notify({ state: "current", message: "部署器已是最新版本" }));
    updater.on("update-available", (info) => {
      notify({ state: "available", message: `发现新版本 ${info.version}` });
      void dialog.showMessageBox({
        type: "info", title: "发现部署器更新", message: `发现新版本 ${info.version}`,
        detail: "更新只替换部署器程序，不会修改已部署机器人、密钥或聊天记忆。",
        buttons: ["下载更新", "稍后"], defaultId: 0, cancelId: 1, noLink: true,
      }).then(async ({ response }) => {
        if (response !== 0) return;
        notify({ state: "downloading", message: `正在下载 ${info.version}…` });
        await updater.downloadUpdate();
      }).catch(reportError);
    });
    updater.on("download-progress", (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
      notify({ state: "downloading", message: `正在下载更新：${percent}%` });
    });
    updater.on("update-downloaded", (info) => {
      notify({ state: "ready", message: `版本 ${info.version} 已下载` });
      void dialog.showMessageBox({
        type: "info", title: "更新已准备好", message: `版本 ${info.version} 已下载完成`,
        detail: "现在重启会自动安装；选择稍后时，将在退出部署器后安装。",
        buttons: ["立即重启安装", "稍后"], defaultId: 0, cancelId: 1, noLink: true,
      }).then(({ response }) => { if (response === 0) updater.quitAndInstall(false, true); }).catch(reportError);
    });
    updater.on("error", reportError);
    setTimeoutFn(() => void check(), FIRST_CHECK_DELAY_MS);
    setIntervalFn(() => void check(), CHECK_INTERVAL_MS);
  }

  return Object.freeze({ start, check });
}
