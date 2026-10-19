; 卸载确认页之前执行，此时主程序还在 $INSTDIR，才能调用 --uninstall-data。
; Tauri 稍后只删除 $LOCALAPPDATA\io.notesae.mdreader，不会删除 %LOCALAPPDATA%\MdReader 或已迁移的数据根。
; 静默卸载不打开确认页，复选框保持未选。/DELETEAPPDATA 才表示明确要求清理；/UPDATE 升级始终保留数据。
!macro NSIS_HOOK_PREUNINSTALL
  ClearErrors
  ${GetOptions} $CMDLINE "/DELETEAPPDATA" $R9
  ${IfNot} ${Errors}
    StrCpy $DeleteAppDataCheckboxState 1
  ${EndIf}
  ClearErrors
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-data' $0
    ${If} $0 <> 0
      ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION "无法安全清理 MD 数据。请关闭应用并完成待处理维护，或返回取消勾选“删除应用数据”以保留数据并卸载。原始文章不会被删除。"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
!macroend
