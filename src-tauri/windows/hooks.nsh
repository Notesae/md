; 复用标准卸载页的“删除应用数据”勾选项；升级和默认卸载保留所有阅读数据。
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-data' $0
    ${If} $0 <> 0
      MessageBox MB_ICONEXCLAMATION "无法安全清理 MD 数据。请关闭应用并完成待处理维护，或返回取消勾选“删除应用数据”以保留数据并卸载。原始文章不会被删除。"
      Abort
    ${EndIf}
  ${EndIf}
!macroend
