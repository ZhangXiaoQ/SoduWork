; Register an explicit action for all files without changing default handlers.
; SHELL_CONTEXT follows the installation scope; the stable launcher survives updates.
!ifndef SODUWORK_FILE_VERB
  !if "${APP_ID}" == "com.soduwork.cn"
    !define SODUWORK_FILE_VERB "Software\Classes\*\shell\com.soduwork.cn.Open"
  !else if "${APP_ID}" == "com.soduwork.global"
    !define SODUWORK_FILE_VERB "Software\Classes\*\shell\com.soduwork.global.Open"
  !else
    !define SODUWORK_FILE_VERB "Software\Classes\*\shell\SoduWork.Open"
  !endif
!endif
!ifndef SODUWORK_OPEN_APP
  !define SODUWORK_OPEN_APP "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
!endif
!macro soduworkRegisterFileOpen
  ; Retire only this installation's legacy SoduWork context-menu entry; preserve other brands and directories.
  !if "${SODUWORK_FILE_VERB}" == "Software\Classes\*\shell\SoduWork.Open"
    ReadRegStr $0 SHELL_CONTEXT "Software\Classes\*\shell\SoduWork.Open\command" ""
    ${If} $0 == '"$soduWorkRoot\${APP_EXECUTABLE_FILENAME}" --soduwork-open-file "%1"'
      DeleteRegKey SHELL_CONTEXT "Software\Classes\*\shell\SoduWork.Open"
    ${EndIf}
  !endif
  WriteRegStr SHELL_CONTEXT "${SODUWORK_FILE_VERB}" "" "用 ${PRODUCT_NAME} 打开"
  WriteRegStr SHELL_CONTEXT "${SODUWORK_FILE_VERB}" "Icon" '"$appExe",0'
  WriteRegStr SHELL_CONTEXT "${SODUWORK_FILE_VERB}" "MultiSelectModel" "Single"
  WriteRegStr SHELL_CONTEXT "${SODUWORK_FILE_VERB}\command" "" '"$appExe" --soduwork-open-file "%1"'
  WriteRegStr SHELL_CONTEXT "${SODUWORK_OPEN_APP}" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${SODUWORK_OPEN_APP}\shell\open\command" "" '"$appExe" --soduwork-open-file "%1"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !ifmacrodef soduworkPrepareResourceUninstall
    !insertmacro soduworkPrepareResourceUninstall
  !endif
  ; An older/parallel installation must not remove a newer installation's entry.
  ReadRegStr $0 SHELL_CONTEXT "${SODUWORK_FILE_VERB}\command" ""
  ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --soduwork-open-file "%1"'
    DeleteRegKey SHELL_CONTEXT "${SODUWORK_FILE_VERB}"
  ${EndIf}
  ReadRegStr $0 SHELL_CONTEXT "${SODUWORK_OPEN_APP}\shell\open\command" ""
  ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --soduwork-open-file "%1"'
    DeleteRegKey SHELL_CONTEXT "${SODUWORK_OPEN_APP}"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
