# WebGPU Inspector in the Tauri editor

On Windows, start the development editor with:

```powershell
npm run tauri:inspect
```

The first run downloads the pinned WebGPU Inspector release into the ignored
`artifacts/` cache. The command launches a separate WebView2 profile with
browser extensions enabled; normal `npm run tauri dev`, release editor builds,
and exported games do not load or ship the inspector.

Press `F12` in the editor and select the **WebGPU Inspector** tab. Open that tab
before capturing and reload the editor once (`Ctrl+R`) so the extension observes
GPU objects created during renderer startup. The inspector profile has separate
WebView storage, so it may ask for a project once even if the normal editor
already remembers one.

Run only the download/install step with:

```powershell
npm run tauri:inspect:prepare
```
