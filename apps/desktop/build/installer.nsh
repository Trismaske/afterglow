; Afterglow NSIS hooks (v0.5): ship a Windows screensaver entry point.
;
; A .scr is just a renamed exe that Windows launches with /s (run),
; /p <hwnd> (preview) or /c (configure) — all handled by the app's
; launch-mode parsing (src/main/launch.ts). So the installer simply copies
; the installed exe to Afterglow.scr next to it; the in-app "Set as default
; screensaver" button then registers that path under
; HKCU\Control Panel\Desktop\SCRNSAVE.EXE.

!macro customInstall
  ; ${APP_EXECUTABLE_FILENAME} is provided by electron-builder ("Afterglow.exe").
  CopyFiles /SILENT "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\Afterglow.scr"
!macroend

!macro customUnInstall
  ; If we are the registered screensaver, deregister before deleting the .scr
  ; (leaving SCRNSAVE.EXE pointing at a dead file breaks the OS dialog).
  ReadRegStr $0 HKCU "Control Panel\Desktop" "SCRNSAVE.EXE"
  ${If} $0 == "$INSTDIR\Afterglow.scr"
    DeleteRegValue HKCU "Control Panel\Desktop" "SCRNSAVE.EXE"
  ${EndIf}
  Delete "$INSTDIR\Afterglow.scr"
!macroend
