!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Restoring Android system image"
  Delete "$INSTDIR\android-runtime\sdk\system-images\android-35\google_apis\x86_64\system.img"
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /d /c copy /b "$INSTDIR\android-runtime\sdk\system-images\android-35\google_apis\x86_64\system.img.part01"+"$INSTDIR\android-runtime\sdk\system-images\android-35\google_apis\x86_64\system.img.part02" "$INSTDIR\android-runtime\sdk\system-images\android-35\google_apis\x86_64\system.img"'
  Pop $0
  StrCmp $0 "0" restore_ok
  MessageBox MB_ICONSTOP "Android system image restore failed ($0)."
  Abort
restore_ok:
  Delete "$INSTDIR\android-runtime\sdk\system-images\android-35\google_apis\x86_64\system.img.part01"
  Delete "$INSTDIR\android-runtime\sdk\system-images\android-35\google_apis\x86_64\system.img.part02"
!macroend
