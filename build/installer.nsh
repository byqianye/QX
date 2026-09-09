!macro customInstallSection
  ; Optional cleanup for an older QX影视 installation in the same directory.
  ; It is intentionally unchecked so upgrades keep the existing installation
  ; and user data unless the user explicitly chooses cleanup.
  Section /o "卸载旧版本（保留用户数据）" UNINSTALL_OLD_QX
    IfFileExists "$INSTDIR\Uninstall QX影视.exe" 0 +3
      ExecWait '"$INSTDIR\Uninstall QX影视.exe" /S'
      Sleep 500
  SectionEnd
!macroend

!macro customUnInstallSection
  ; Optional uninstall component. The default is unchecked, so user data is kept.
  Section /o "删除 QX影视用户数据（设置、历史和缓存）" DELETE_QX_USER_DATA
    RMDir /r "$APPDATA\QX影视"
    RMDir /r "$APPDATA\qx-yingshi"
  SectionEnd
!macroend
