!include LogicLib.nsh
!include nsDialogs.nsh

Var QxOldUninstaller
Var QxUninstallOldCheckbox

; The page is skipped when no previous per-user or per-machine install exists.
Page custom QxUninstallOldPage QxUninstallOldPageLeave

Function QxUninstallOldPage
  StrCpy $QxOldUninstaller ""
  ReadRegStr $QxOldUninstaller HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QX影视" "UninstallString"
  ${If} $QxOldUninstaller == ""
    ReadRegStr $QxOldUninstaller HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\QX影视" "UninstallString"
  ${EndIf}
  ${If} $QxOldUninstaller == ""
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "安装前处理"
  Pop $0
  ${NSD_CreateCheckbox} 0 32u 100% 14u "卸载旧版本（保留用户数据）"
  Pop $QxUninstallOldCheckbox
  ${NSD_SetState} $QxUninstallOldCheckbox ${BST_UNCHECKED}
  nsDialogs::Show
FunctionEnd

Function QxUninstallOldPageLeave
  ${NSD_GetState} $QxUninstallOldCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    ${If} $QxOldUninstaller != ""
      ExecWait '$QxOldUninstaller /S' $1
    ${EndIf}
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
