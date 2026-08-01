const INVOKE_CHANNELS = Object.freeze({
  checkEnvironment: "deploy:check-environment",
  selectPersona: "deploy:select-persona",
  start: "deploy:start",
  resume: "deploy:resume",
  cancel: "deploy:cancel",
  openOutputFolder: "deploy:open-output-folder",
  readDisclaimer: "deploy:read-disclaimer",
});

export function createPreloadApi(ipcRenderer) {
  const api = {
    checkEnvironment: () => ipcRenderer.invoke(INVOKE_CHANNELS.checkEnvironment),
    selectPersona: () => ipcRenderer.invoke(INVOKE_CHANNELS.selectPersona),
    start: (input) => ipcRenderer.invoke(INVOKE_CHANNELS.start, input),
    resume: (input) => ipcRenderer.invoke(INVOKE_CHANNELS.resume, input),
    cancel: (jobId) => ipcRenderer.invoke(INVOKE_CHANNELS.cancel, jobId),
    openOutputFolder: (outputDir) => ipcRenderer.invoke(INVOKE_CHANNELS.openOutputFolder, outputDir),
    readDisclaimer: (language) => ipcRenderer.invoke(INVOKE_CHANNELS.readDisclaimer, language),
    onProgress: (listener) => {
      if (typeof listener !== "function") throw new TypeError("Progress listener must be a function");
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("deploy:progress", wrapped);
      return () => ipcRenderer.removeListener("deploy:progress", wrapped);
    },
    onUpdateStatus: (listener) => {
      if (typeof listener !== "function") throw new TypeError("Update listener must be a function");
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("update:status", wrapped);
      return () => ipcRenderer.removeListener("update:status", wrapped);
    },
  };
  return Object.freeze(api);
}
