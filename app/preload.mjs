import { contextBridge, ipcRenderer } from "electron";
import { createPreloadApi } from "./preload-api.mjs";

contextBridge.exposeInMainWorld("deployer", createPreloadApi(ipcRenderer));
