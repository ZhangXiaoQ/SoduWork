; SoduWork installation identity and safe in-place upgrade checks.
!ifndef SODUWORK_PREVIOUS_INSTALL_GUID
  !if "${APP_ID}" == "com.soduwork.app"
    !define SODUWORK_PREVIOUS_INSTALL_GUID "1950f0e5-fb32-5782-95db-b8bf71cad731"
  !endif
!endif
!ifdef SODUWORK_PREVIOUS_INSTALL_GUID
  !define SODUWORK_PREVIOUS_INSTALL_KEY "Software\${SODUWORK_PREVIOUS_INSTALL_GUID}"
  !define SODUWORK_PREVIOUS_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SODUWORK_PREVIOUS_INSTALL_GUID}"
  Var soduworkPreviousInstallMatched
  Var soduworkPreviousInstallCommand
!endif

!macro soduworkSelectIndependentDirectory
  ; Never overwrite another SoduWork distribution or share its payload.
  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${If} ${FileExists} "$INSTDIR\SoduWork.exe"
    ${OrIf} ${FileExists} "$INSTDIR\SoduWork CN.exe"
    ${OrIf} ${FileExists} "$INSTDIR\SoduWork Global.exe"
      ${GetParent} "$INSTDIR" $0
      !if "${APP_ID}" == "com.soduwork.cn"
        StrCpy $INSTDIR "$0\SoduWork CN"
      !else if "${APP_ID}" == "com.soduwork.global"
        StrCpy $INSTDIR "$0\SoduWork Global"
      !else
        StrCpy $INSTDIR "$0\SoduWork"
      !endif
    ${EndIf}
  ${EndIf}
  ; Refuse an identifiable distribution when its own launcher is absent.
  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${If} ${FileExists} "$INSTDIR\SoduWork.exe"
    ${OrIf} ${FileExists} "$INSTDIR\SoduWork CN.exe"
    ${OrIf} ${FileExists} "$INSTDIR\SoduWork Global.exe"
    MessageBox MB_OK|MB_ICONEXCLAMATION "此目录属于另一个 SoduWork 客户端，请选择此环境的独立安装目录。" /SD IDOK
    SetErrorLevel 2
    Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro soduworkDetectPreviousInstall
  !ifdef SODUWORK_PREVIOUS_INSTALL_GUID
    StrCpy $soduworkPreviousInstallMatched 0
    ReadRegStr $0 SHELL_CONTEXT "${SODUWORK_PREVIOUS_INSTALL_KEY}" InstallLocation
    ReadRegStr $1 SHELL_CONTEXT "${SODUWORK_PREVIOUS_UNINSTALL_KEY}" UninstallString
    ReadRegStr $2 SHELL_CONTEXT "${SODUWORK_PREVIOUS_UNINSTALL_KEY}" DisplayName
    ReadRegStr $3 SHELL_CONTEXT "${SODUWORK_PREVIOUS_UNINSTALL_KEY}" DisplayVersion
    StrCpy $4 "/currentuser"
    ${If} $installMode == "all"
      StrCpy $4 "/allusers"
    ${EndIf}
    ${If} $0 != ""
      GetFullPathName $0 "$0"
      GetFullPathName $5 "$soduWorkRoot"
      ${If} $0 == $5
      ${AndIf} $3 != ""
      ${AndIf} $2 == "SoduWork $3"
      ${AndIf} $1 == '"$soduWorkRoot\${UNINSTALL_FILENAME}" $4'
      ${AndIf} ${FileExists} "$soduWorkRoot\${APP_EXECUTABLE_FILENAME}"
        StrCpy $soduworkPreviousInstallMatched 1
        StrCpy $soduworkPreviousInstallCommand $1
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!macro soduworkCommitPreviousInstall
  !ifdef SODUWORK_PREVIOUS_INSTALL_GUID
    ${If} $soduworkPreviousInstallMatched == 1
      ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
      ReadRegStr $1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${If} $0 == "$soduWorkRoot"
      ${AndIf} $1 == $soduworkPreviousInstallCommand
      ${AndIf} ${FileExists} "$soduWorkRoot\${UNINSTALL_FILENAME}"
        ReadRegStr $0 SHELL_CONTEXT "${SODUWORK_PREVIOUS_INSTALL_KEY}" InstallLocation
        ReadRegStr $1 SHELL_CONTEXT "${SODUWORK_PREVIOUS_UNINSTALL_KEY}" UninstallString
        ReadRegStr $2 SHELL_CONTEXT "${SODUWORK_PREVIOUS_UNINSTALL_KEY}" DisplayName
        ReadRegStr $3 SHELL_CONTEXT "${SODUWORK_PREVIOUS_UNINSTALL_KEY}" DisplayVersion
        ${If} $0 != ""
          GetFullPathName $0 "$0"
          GetFullPathName $4 "$soduWorkRoot"
          ${If} $0 == $4
          ${AndIf} $1 == $soduworkPreviousInstallCommand
          ${AndIf} $3 != ""
          ${AndIf} $2 == "SoduWork $3"
            DeleteRegKey SHELL_CONTEXT "${SODUWORK_PREVIOUS_UNINSTALL_KEY}"
            DeleteRegKey SHELL_CONTEXT "${SODUWORK_PREVIOUS_INSTALL_KEY}"
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !endif
!macroend
