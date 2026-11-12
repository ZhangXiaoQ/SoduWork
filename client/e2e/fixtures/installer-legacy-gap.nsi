; Controlled reproduction of the old delete-before-install ordering.
; Only a test-owned directory selected at compile time is allowed.
Unicode true
RequestExecutionLevel user
SilentInstall silent
!ifndef SODUWORK_E2E_EXECUTABLE_NAME
  !error "An isolated fixture executable name is required"
!endif
OutFile "${SODUWORK_E2E_BASELINE_OUT}"
Section
  StrCpy $INSTDIR "${SODUWORK_E2E_ROOT}"
  IfFileExists "$INSTDIR\.soduwork-e2e-owned" +2
    Quit
  ClearErrors
  Delete "$INSTDIR\${SODUWORK_E2E_EXECUTABLE_NAME}.exe"
  IfErrors 0 +3
    SetErrorLevel 3
    Quit
  Sleep 1500
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\${SODUWORK_E2E_EXECUTABLE_NAME}.pre-test.exe" "$INSTDIR\${SODUWORK_E2E_EXECUTABLE_NAME}.exe"
  IfErrors 0 +3
    SetErrorLevel 4
    Quit
  IfFileExists "$INSTDIR\${SODUWORK_E2E_EXECUTABLE_NAME}.exe" +3
    SetErrorLevel 5
    Quit
SectionEnd
