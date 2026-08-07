!macro customUnInstallSection
  ; Optional uninstall component. The default is unchecked, so user data is kept.
  Section /o "删除 QX影视用户数据（设置、历史和缓存）" DELETE_QX_USER_DATA
    RMDir /r "$APPDATA\QX影视"
    RMDir /r "$APPDATA\qx-yingshi"
  SectionEnd
!macroend
